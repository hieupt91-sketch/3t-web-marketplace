import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  completeJob,
  emitEvent,
  failJob,
  validateDynamicContent,
  type Db,
  type JobRow,
  type LocalObjectStore,
  type PlatformConfig,
} from '@3t/core';
import { extractArchive } from '@3t/template-sdk';
import { httpStatus, killPid, siteLimitsOf, spawnServer, writeSiteMeta, type SpawnSpec } from './runtime-agent.ts';
import { allocateSiteUid, fenceSiteTree, sandboxEnabled } from './sandbox.ts';

export const SITE_JOB_TYPES = ['site.provision', 'site.backup', 'site.restore', 'site.update', 'site.restart', 'site.content-backup', 'site.content-restore'] as const;

interface SiteRow {
  id: string;
  owner_id: string;
  entitlement_id: string | null;
  template_version_id: string;
  display_name: string;
  subdomain: string | null;
  default_locale: string;
  status: string;
  demo_session_id: string | null;
  runtime_kind: string | null;
  runtime_port: number | null;
  runtime_pid: number | null;
  runtime_uid: number | null;
}

interface VersionRow {
  id: string;
  adapter: string;
  manifest_json: { runtime?: { start?: string[]; healthPath?: string }; env?: { name: string; scope: string; defaultValue?: string }[] };
  artifact_key: string;
}

function execFileAsync(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 300_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${String(stderr).slice(0, 500)}`));
      else resolve();
    });
  });
}

async function loadSite(db: Db, id: string): Promise<SiteRow> {
  const { rows } = await db.query<SiteRow>('SELECT * FROM sites WHERE id = $1', [id]);
  if (!rows[0]) throw new Error(`site not found: ${id}`);
  return rows[0]!;
}

async function loadVersion(db: Db, id: string): Promise<VersionRow> {
  const { rows } = await db.query<VersionRow>(
    `SELECT v.id, v.adapter, v.manifest_json, a.object_key AS artifact_key
     FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`version not found: ${id}`);
  return rows[0]!;
}

function siteDir(config: PlatformConfig, siteId: string): string {
  return join(config.workDir, 'sites', siteId);
}

function spawnSpec(version: VersionRow, dir: string) {
  const isStatic = version.adapter === 'static-html' || version.adapter === 'vite-static';
  const env: Record<string, string> = {};
  for (const item of version.manifest_json.env ?? []) {
    if (item.scope === 'public' && item.defaultValue !== undefined) env[item.name] = item.defaultValue;
  }
  return {
    kind: (isStatic ? 'static' : 'runtime') as 'static' | 'runtime',
    dir,
    start: version.manifest_json.runtime?.start,
    healthPath: version.manifest_json.runtime?.healthPath ?? '/',
    env,
  };
}

async function materialize(store: LocalObjectStore, version: VersionRow, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(store.pathFor(version.artifact_key), target, { recursive: true, dereference: false });
}

/**
 * Files inside a demo session's data/ that must never cross into a real
 * site (audit H-01): the demo admin account is created with the PUBLIC
 * demo password (admin/Demo1234), the session-key would keep any demo
 * session token valid for a same-named account, and a stale setup token
 * is meaningless once the account is gone. Removing all three drops the
 * promoted tree into the exact first-run state of a fresh site: the
 * engine boots without an admin, writes a fresh one-time setup token,
 * and the buyer claims the site through the platform's admin-setup flow.
 * Everything else in data/ (content edits, bookings, uploads, the Sheet
 * integration) is the buyer's own work and is preserved verbatim.
 */
export const DEMO_CREDENTIAL_FILES = ['admin.json', 'session-key', 'setup-token.txt'] as const;

export async function stripDemoCredentials(siteDirPath: string): Promise<void> {
  for (const name of DEMO_CREDENTIAL_FILES) {
    await rm(join(siteDirPath, 'data', name), { force: true });
  }
}

/**
 * Spawn with the sandbox Phase 0 spec (audit C-01): the site's allocated
 * UID (allocated on first spawn, then stable), prlimit caps, and the
 * site's data/ as the child's HOME/TMPDIR. The tree is fenced to the UID
 * before every spawn — fencing is idempotent, so restarts re-assert it
 * and an update's freshly swapped tree (root-owned copies, carried data)
 * is re-owned correctly before the new code ever runs.
 */
async function spawnAndRecord(config: PlatformConfig, db: Db, site: SiteRow, version: VersionRow, dir: string): Promise<void> {
  const base = spawnSpec(version, dir);
  await mkdir(join(dir, 'data', '.tmp'), { recursive: true });
  const uid = await allocateSiteUid(db, config, site.id);
  if (uid !== null) await fenceSiteTree(config, dir, uid);
  const spec: SpawnSpec = {
    ...base,
    limits: siteLimitsOf(config),
    writableDir: join(dir, 'data'),
    ...(uid !== null ? { uid, gid: config.siteGid } : {}),
  };
  const spawned = await spawnServer(config, spec);
  await db.query('UPDATE sites SET runtime_kind = $2, runtime_port = $3, runtime_pid = $4 WHERE id = $1', [
    site.id,
    base.kind,
    spawned.port,
    spawned.pid,
  ]);
}

/**
 * Boot backfill (plan Phase 0 item 2): sites provisioned before sandbox
 * fencing existed get their UID allocation + tree fencing once, at worker
 * start. Their running processes keep the old UID until their next
 * restart, but the fencing itself (0700 data/) takes effect immediately —
 * and in production those processes run as root, which bypasses the
 * fencing for the site's own tree only, never for other tenants'.
 */
export async function backfillSandboxFencing(deps: { config: PlatformConfig; db: Db }): Promise<number> {
  const { config, db } = deps;
  if (!sandboxEnabled(config)) return 0;
  const { rows } = await db.query<{ id: string }>("SELECT id FROM sites WHERE status IN ('active', 'grace')");
  let fenced = 0;
  for (const row of rows) {
    try {
      const site = await loadSite(db, row.id);
      const uid = await allocateSiteUid(db, config, site.id);
      if (uid === null) continue;
      const dir = siteDir(config, site.id);
      if (existsSync(dir)) {
        await fenceSiteTree(config, dir, uid);
        fenced++;
      }
    } catch (error) {
      console.log(JSON.stringify({ event: 'sandbox_backfill_site_failed', site_id: row.id, error: (error as Error).message }));
    }
  }
  return fenced;
}

/**
 * Provisioning saga (M5, docs/11 §4): reserve (done at creation by the unique
 * subdomain) → volume → runtime → seed/meta → health → route → active.
 * Every step is idempotent so a retry reuses the same site id (AT-23): the
 * volume is re-materialized from the version artifact and the server respawned.
 * A failed provision never deletes the site and never claws back the
 * entitlement — the owner retries the same site.
 */
async function runProvision(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, deploymentId: string | null): Promise<void> {
  const { config, db, store } = deps;
  const version = await loadVersion(db, site.template_version_id);
  const dir = siteDir(config, site.id);
  if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
  try {
    if (site.runtime_pid) killPid(site.runtime_pid);
    // Demo promotion (D02->C05): a runtime demo session's directory becomes the
    // site volume verbatim, so demo edits survive; the session is then closed.
    // Static demos have no directory (they reuse a preview), so they fall
    // through to normal materialization from the immutable version artifact.
    let promoted = false;
    if (site.demo_session_id) {
      const demoDir = join(config.workDir, 'demo-sessions', site.demo_session_id);
      const { existsSync } = await import('node:fs');
      if (existsSync(demoDir)) {
        await rm(dir, { recursive: true, force: true });
        await cp(demoDir, dir, { recursive: true, dereference: false });
        // The demo's admin account uses a public password: it and every
        // credential artefact die here, before the tree can boot as a
        // real site (audit H-01). The buyer's demo edits survive.
        await stripDemoCredentials(dir);
        await db.query("UPDATE demo_sessions SET status = 'cancelled' WHERE id = $1", [site.demo_session_id]);
        promoted = true;
      }
    }
    if (!promoted) await materialize(store, version, dir);
    await writeSiteMeta(dir, { display_name: site.display_name, locale: site.default_locale, subdomain: site.subdomain, version_id: version.id });
    await spawnAndRecord(config, db, site, version, dir);
    await db.query("UPDATE sites SET status = 'active' WHERE id = $1", [site.id]);
    // Subscription from the entitlement's order item (one active per site).
    if (site.entitlement_id) {
      const item = await db.query<{ plan_id: string; interval: string }>(
        `SELECT oi.plan_id, pp.interval FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id
         LEFT JOIN plans p ON p.id = oi.plan_id
         LEFT JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = 'VND' AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
         WHERE e.id = $1 LIMIT 1`,
        [site.entitlement_id],
      );
      const planId = item.rows[0]?.plan_id;
      if (planId) {
        const periodDays = item.rows[0]?.interval === 'monthly' ? 30 : 365;
        await db.query(
          `INSERT INTO subscriptions (site_id, plan_id, current_period_start, current_period_end, policy_snapshot)
           SELECT $1, $2, now(), now() + make_interval(days => $3), $4::jsonb
           WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE site_id = $1 AND status = 'active')`,
          [site.id, planId, periodDays, JSON.stringify({ period_days: periodDays, grace_days: 7, retention_days: 30 })],
        );
      }
    }
    if (deploymentId) await db.query("UPDATE deployments SET status = 'succeeded', finished_at = now() WHERE id = $1", [deploymentId]);
    await emitEvent(db, 'site.ready', 'site', site.id, { site_id: site.id, subdomain: site.subdomain });
  } catch (error) {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'failed', finished_at = now(), error_code = 'site_provision_failed' WHERE id = $1", [deploymentId]);
    await db.query("UPDATE sites SET status = 'provision_failed' WHERE id = $1", [site.id]);
    throw error;
  }
}

async function runBackup(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, backupId: string): Promise<void> {
  const { config, db, store } = deps;
  const dir = siteDir(config, site.id);
  const tmp = await mkdtemp(join(tmpdir(), 'mp-backup-'));
  try {
    const zipPath = join(tmp, 'backup.zip');
    await execFileAsync('zip', ['-q', '-r', zipPath, '.'], dir);
    const stored = await store.putStream(`backups/${site.id}/${backupId}.zip`, createReadStream(zipPath), 1024 * 1024 * 1024);
    const artifact = await db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
       VALUES ($1, $2, $3, 'application/zip', 'site_backup', 'permanent', $4) RETURNING id`,
      [`backups/${site.id}/${backupId}.zip`, stored.sha256, String(stored.size), { site_id: site.id, backup_id: backupId }],
    );
    await db.query("UPDATE backups SET status = 'succeeded', artifact_id = $2, checksum = $3, expires_at = now() + interval '30 days' WHERE id = $1", [backupId, artifact.rows[0]!.id, stored.sha256]);
  } catch (error) {
    await db.query("UPDATE backups SET status = 'failed' WHERE id = $1", [backupId]);
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Swap the site tree to a staged tree, respawn, health-check; roll back on failure. */
async function swapAndRespawn(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, site: SiteRow, staged: string, version: VersionRow): Promise<void> {
  const { config, db } = deps;
  const dir = siteDir(config, site.id);
  const kept = `${dir}.kept-${Date.now()}`;
  if (site.runtime_pid) killPid(site.runtime_pid);
  await rename(dir, kept);
  try {
    await rename(staged, dir);
    await spawnAndRecord(config, db, site, version, dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    await rename(kept, dir);
    // Best-effort: bring the old tree back up so a failed update never leaves the site down.
    try {
      const oldVersion = await loadVersion(db, site.template_version_id);
      await spawnAndRecord(config, db, site, oldVersion, dir);
    } catch {
      /* site stays down; deployment records the failure */
    }
    throw error;
  }
  await rm(kept, { recursive: true, force: true });
}

/**
 * Extract a site backup into an (existing, empty) staging directory via
 * the platform's verified extractor — the same `extractArchive` the
 * import pipeline uses (audit code L-02). It validates the WHOLE central
 * directory before writing a single byte and rejects symlink/special
 * entries, `../`/absolute/drive-letter names, encrypted entries and
 * name collisions, so a crafted backup (site trees are influenced by
 * template code) cannot write through a symlink out of the staging dir
 * the way the old system-`unzip` call could. One behavioural note versus
 * `unzip`: a backup whose entries all live under a single top-level
 * directory has that wrapper stripped (the extractor's documented rule);
 * platform backups are zipped from the site root (`zip -r .`), whose
 * trees always carry several top-level entries, so this never triggers
 * for a platform-made backup. Exported for tests.
 */
export async function extractBackupArchive(zipPath: string, destination: string): Promise<void> {
  await extractArchive(zipPath, destination);
}

async function runRestore(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, backupId: string, deploymentId: string | null): Promise<void> {
  const { config, db, store } = deps;
  const backup = await db.query<{ artifact_key: string }>(
    `SELECT a.object_key AS artifact_key FROM backups b JOIN artifacts a ON a.id = b.artifact_id WHERE b.id = $1 AND b.status = 'succeeded'`,
    [backupId],
  );
  if (!backup.rows[0]) throw new Error('backup not restorable');
  // Same-filesystem staging as runUpdate: the swap renames the staged
  // tree into place, which cannot cross filesystems.
  await mkdir(join(config.workDir, 'tmp'), { recursive: true });
  const tmp = await mkdtemp(join(config.workDir, 'tmp', 'mp-restore-'));
  try {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
    const staged = join(tmp, 'staged');
    await mkdir(staged, { recursive: true });
    await extractBackupArchive(store.pathFor(backup.rows[0]!.artifact_key), staged);
    const version = await loadVersion(db, site.template_version_id);
    await swapAndRespawn(deps, site, staged, version);
    if (deploymentId) await db.query("UPDATE deployments SET status = 'succeeded', finished_at = now() WHERE id = $1", [deploymentId]);
  } catch (error) {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'failed', finished_at = now(), error_code = 'site_restore_failed' WHERE id = $1", [deploymentId]);
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Copy the site's live `data/` tree over the staged tree's `data/` so an
 * update never resets the customer's own data — edited content
 * (content.json), consultation bookings, the site admin account, uploads
 * and the Google Sheet integration file all live there, while the version
 * artifact only ships code + seed. The customer's copy always wins: any
 * `data/` the artifact might carry is removed first so no artifact file
 * can shadow a customer file of the same name. No-op when the live site
 * has no data directory (static sites, fresh trees).
 */
export async function carrySiteData(fromDir: string, toDir: string): Promise<void> {
  const source = join(fromDir, 'data');
  if (!existsSync(source)) return;
  const target = join(toDir, 'data');
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: false });
}

/** A site-job failure carrying the machine code recorded on the job row. */
export class SiteJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Free-update deadline — PARITY with the API's `updatesFreeUntil`
 * (apps/api/src/routes/sites.ts; keep the two in step). Updates are free
 * for 12 months from the purchase, anchored on the entitlement's
 * creation; a site with no entitlement has no deadline (the API
 * intentionally does not gate those). A non-active entitlement (revoked
 * by a full refund) carries no update right: its deadline collapses to
 * the purchase instant, i.e. always already expired.
 */
export async function siteUpdateFreeUntil(db: Db, entitlementId: string | null): Promise<Date | null> {
  if (!entitlementId) return null;
  const { rows } = await db.query<{ free_until: Date }>(
    `SELECT CASE WHEN status = 'active' THEN created_at + interval '12 months' ELSE created_at END AS free_until
     FROM entitlements WHERE id = $1`,
    [entitlementId],
  );
  return rows[0]?.free_until ?? null;
}

/**
 * Worker-side re-check of the 12-month free-update window (audit
 * payments L7). The API gates POST /sites/:id/update at enqueue time,
 * but a queued job can run after the deadline passes; the worker is the
 * point of execution, so it re-derives the window from the DB before
 * touching anything. Throws SiteJobError('site_update_window_expired').
 */
export async function assertSiteUpdateAllowed(db: Db, site: Pick<SiteRow, 'entitlement_id'>, now: Date = new Date()): Promise<void> {
  const freeUntil = await siteUpdateFreeUntil(db, site.entitlement_id);
  if (freeUntil && new Date(freeUntil).getTime() <= now.getTime()) {
    throw new SiteJobError(
      'site_update_window_expired',
      `free update window for site entitlement ${site.entitlement_id} expired at ${new Date(freeUntil).toISOString()}`,
    );
  }
}

export async function runUpdate(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, versionId: string, deploymentId: string | null): Promise<void> {
  const { config, db, store } = deps;
  // Window re-check FIRST (audit payments L7): an expired job fails
  // before any staging directory is made and the site's files are never
  // touched. No entitlement → no gate, exactly as at the API.
  try {
    await assertSiteUpdateAllowed(db, site);
  } catch (error) {
    if (deploymentId) {
      await db.query("UPDATE deployments SET status = 'failed', finished_at = now(), error_code = 'site_update_window_expired' WHERE id = $1", [deploymentId]);
    }
    throw error;
  }
  const version = await loadVersion(db, versionId);
  // Stage on the same filesystem as the site tree: swapAndRespawn swaps
  // by rename(), which fails with EXDEV across filesystems (os tmpdir is
  // typically a tmpfs while workDir is on disk).
  await mkdir(join(config.workDir, 'tmp'), { recursive: true });
  const tmp = await mkdtemp(join(config.workDir, 'tmp', 'mp-update-'));
  try {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
    const staged = join(tmp, 'staged');
    await materialize(store, version, staged);
    // The staged tree is code-only; carry the customer's live data/ into
    // it before the swap so the new version boots with their data intact.
    // The kept old tree still holds its own copy, so a failed swap rolls
    // back with data untouched (swapAndRespawn semantics unchanged).
    await carrySiteData(siteDir(config, site.id), staged);
    await writeSiteMeta(staged, { display_name: site.display_name, locale: site.default_locale, subdomain: site.subdomain, version_id: version.id });
    await swapAndRespawn(deps, site, staged, version);
    await db.query('UPDATE sites SET template_version_id = $2 WHERE id = $1', [site.id, versionId]);
    if (deploymentId) await db.query("UPDATE deployments SET status = 'succeeded', finished_at = now() WHERE id = $1", [deploymentId]);
  } catch (error) {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'failed', finished_at = now(), error_code = 'site_update_failed' WHERE id = $1", [deploymentId]);
    throw error;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Dynamic content backup (docs/12): the dynamic family's own backup unit
 * is data/content.json — the same file the site's built-in admin offers
 * for download. The platform stores it as a 'content' backup so customers
 * can snapshot content without a whole-tree backup. The file is
 * shape-validated on the way in AND on restore, so a corrupt snapshot
 * can never be applied.
 */
async function runContentBackup(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, backupId: string): Promise<void> {
  const { config, db, store } = deps;
  try {
    const raw = await readFile(join(siteDir(config, site.id), 'data', 'content.json'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('site content is not valid JSON');
    }
    const invalid = validateDynamicContent(parsed);
    if (invalid) throw new Error(`site content invalid: ${invalid}`);
    const stored = await store.putStream(`content-backups/${site.id}/${backupId}.json`, Readable.from([raw]), 16 * 1024 * 1024);
    const artifact = await db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
       VALUES ($1, $2, $3, 'application/json', 'site_content', 'permanent', $4) RETURNING id`,
      [`content-backups/${site.id}/${backupId}.json`, stored.sha256, String(stored.size), { site_id: site.id, backup_id: backupId }],
    );
    await db.query("UPDATE backups SET status = 'succeeded', artifact_id = $2, checksum = $3, expires_at = now() + interval '30 days' WHERE id = $1", [backupId, artifact.rows[0]!.id, stored.sha256]);
  } catch (error) {
    await db.query("UPDATE backups SET status = 'failed' WHERE id = $1", [backupId]);
    throw error;
  }
}

async function runContentRestore(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, backupId: string, deploymentId: string | null): Promise<void> {
  const { config, db, store } = deps;
  const backup = await db.query<{ artifact_key: string }>(
    `SELECT a.object_key AS artifact_key FROM backups b JOIN artifacts a ON a.id = b.artifact_id
     WHERE b.id = $1 AND b.site_id = $2 AND b.kind = 'content' AND b.status = 'succeeded'`,
    [backupId, site.id],
  );
  if (!backup.rows[0]) throw new Error('content backup not restorable');
  try {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
    const raw = await readFile(store.pathFor(backup.rows[0]!.artifact_key));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('content backup is not valid JSON');
    }
    const invalid = validateDynamicContent(parsed);
    if (invalid) throw new Error(`content backup invalid: ${invalid}`);
    const dataDir = join(siteDir(config, site.id), 'data');
    await mkdir(dataDir, { recursive: true });
    const target = join(dataDir, 'content.json');
    // Mirror the template's own restore: keep the current file as .bak.
    await copyFile(target, `${target}.bak`).catch(() => undefined);
    const tmpFile = join(dataDir, `.content.json.tmp-${Date.now()}`);
    await writeFile(tmpFile, raw);
    await rename(tmpFile, target);
    if (deploymentId) await db.query("UPDATE deployments SET status = 'succeeded', finished_at = now() WHERE id = $1", [deploymentId]);
  } catch (error) {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'failed', finished_at = now(), error_code = 'site_content_restore_failed' WHERE id = $1", [deploymentId]);
    throw error;
  }
}

async function runRestart(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow): Promise<void> {
  const { config, db } = deps;
  // Suspension is a deliberate state (admin action, subscription lapse,
  // full-refund teardown — audit payments H3). Restart jobs also arrive
  // from intents that know nothing about it: the site router's
  // dead-upstream self-heal (which may act on a seconds-old cached
  // 'active' row) and the worker's boot sweep. Those must never
  // resurrect a suspended site: only a job whose payload carries
  // revive:true — set solely by the admin operations endpoint
  // (resume / admin restart) — may lift a suspension.
  const revive = (job.payload_json as { revive?: boolean } | null)?.revive === true;
  if (site.status === 'suspended' && !revive) return;
  if (site.runtime_pid) killPid(site.runtime_pid);
  const version = await loadVersion(db, site.template_version_id);
  const dir = siteDir(config, site.id);
  // Health-check the existing tree first: a restart never re-materializes.
  await spawnAndRecord(config, db, site, version, dir);
  await db.query("UPDATE sites SET status = 'active' WHERE id = $1 AND status IN ('active', 'suspended')", [site.id]);
}

/** Site job runner: owns job completion like runImportJob (no auto-retry for site jobs). */
export async function runSiteJob(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow): Promise<void> {
  const payload = job.payload_json as { site_id: string; deployment_id?: string; backup_id?: string; version_id?: string };
  const site = await loadSite(deps.db, payload.site_id);
  try {
    if (job.type === 'site.provision') await runProvision(deps, job, site, payload.deployment_id ?? null);
    else if (job.type === 'site.backup') await runBackup(deps, job, site, payload.backup_id!);
    else if (job.type === 'site.restore') await runRestore(deps, job, site, payload.backup_id!, payload.deployment_id ?? null);
    else if (job.type === 'site.update') await runUpdate(deps, job, site, payload.version_id!, payload.deployment_id ?? null);
    else if (job.type === 'site.restart') await runRestart(deps, job, site);
    else if (job.type === 'site.content-backup') await runContentBackup(deps, job, site, payload.backup_id!);
    else if (job.type === 'site.content-restore') await runContentRestore(deps, job, site, payload.backup_id!, payload.deployment_id ?? null);
    else throw new Error(`unknown site job type: ${job.type}`);
    await completeJob(deps.db, job);
  } catch (error) {
    // Business failure is recorded on the job/site rows (provision_failed etc.);
    // like runImportJob, the runner does not rethrow it. LeaseLostError from
    // failJob still propagates so another worker's ownership is respected.
    // A SiteJobError carries its own machine code (e.g. the update-window
    // refusal, audit payments L7) so the job row says WHY it failed.
    await failJob(deps.db, job, error instanceof SiteJobError ? error.code : 'site_job_failed', false);
  }
}

export { httpStatus };

/** DEP-06 hygiene: bulk-release expired subdomain holds. The API also
 *  expires lazily on every read path, so this only keeps the table small
 *  and the audit picture honest; correctness never depends on it. */
export async function sweepExpiredReservations(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE subdomain_reservations SET status = 'expired' WHERE status = 'active' AND expires_at <= now()",
  );
  return rowCount ?? 0;
}
