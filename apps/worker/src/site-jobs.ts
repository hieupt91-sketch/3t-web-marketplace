import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  applyReplacements,
  completeJob,
  countForms,
  emitEvent,
  encryptSecret,
  failJob,
  setJobResult,
  validateDynamicContent,
  zipDirectory,
  type Db,
  type JobRow,
  type LocalObjectStore,
  type PlatformConfig,
  type ReplacementPair,
} from '@3t/core';
import { extractArchive } from '@3t/template-sdk';
import { httpStatus, siteLimitsOf, writeSiteMeta, type SpawnSpec } from './runtime-agent.ts';
import { spawnSiteProcess, stopSiteProcess } from './process-agent.ts';
import { allocateSiteUid, fenceSiteTree, releaseSiteUid, sandboxEnabled } from './sandbox.ts';

export const SITE_JOB_TYPES = ['site.provision', 'site.backup', 'site.restore', 'site.update', 'site.restart', 'site.content-backup', 'site.content-restore', 'site.setup-token', 'site.purge', 'site.stop', 'site.visual_edit_apply'] as const;

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
  /** Fencing token for process-agent calls (sandbox Phase 1): the runner
   *  rejects spawns/stops carrying a version older than the one it last
   *  acted on for this site. */
  row_version: number;
}

interface VersionRow {
  id: string;
  adapter: string;
  manifest_json: { runtime?: { start?: string[]; healthPath?: string }; env?: { name: string; scope: string; defaultValue?: string }[] };
  artifact_key: string;
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
  const spawned = await spawnSiteProcess(config, { key: site.id, rowVersion: site.row_version, spec });
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
    if (site.runtime_pid) await stopSiteProcess(config, { key: site.id, rowVersion: site.row_version, localPid: site.runtime_pid });
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
    // In-process zip (core zipDirectory): the worker image ships no
    // `zip` binary — shelling out failed every production backup with
    // ENOENT. Same layout as `zip -r .`: the site dir's contents at
    // the archive root.
    await zipDirectory(dir, zipPath);
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
  if (site.runtime_pid) await stopSiteProcess(config, { key: site.id, rowVersion: site.row_version, localPid: site.runtime_pid });
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
  if (site.runtime_pid) await stopSiteProcess(config, { key: site.id, rowVersion: site.row_version, localPid: site.runtime_pid });
  const version = await loadVersion(db, site.template_version_id);
  const dir = siteDir(config, site.id);
  // Health-check the existing tree first: a restart never re-materializes.
  await spawnAndRecord(config, db, site, version, dir);
  await db.query("UPDATE sites SET status = 'active' WHERE id = $1 AND status IN ('active', 'suspended')", [site.id]);
}

/**
 * Read a site's one-time admin setup token out of its fenced tree
 * (H2 gating fix 1). The file is written by the site's own engine at
 * boot while no admin exists and removed when setup completes, so its
 * current content IS the setup state: missing/empty file → null (setup
 * not pending). Only the worker may read it — the tree is fenced to
 * the site's UID (01700/0700), which the non-root API cannot traverse.
 * Exported for tests.
 */
export async function readSiteSetupToken(config: PlatformConfig, siteId: string): Promise<string | null> {
  try {
    const raw = await readFile(join(siteDir(config, siteId), 'data', 'setup-token.txt'), 'utf8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * site.setup-token (H2 gating fix 1): the API enqueues this job from
 * GET /sites/:id/admin-setup and waits for the result. The token
 * crosses the jobs table ONLY sealed with the platform envelope key
 * (core encryptSecret, keyed like the settings/MFA envelope) and the
 * API scrubs the result row right after reading it, so the one-time
 * credential never rests in the database in plaintext.
 */
async function runSetupToken(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow): Promise<void> {
  const token = await readSiteSetupToken(deps.config, site.id);
  await setJobResult(deps.db, job, {
    token_enc: token ? encryptSecret(deps.config.partnerWebhookKey, token) : null,
  });
}

/**
 * Delete a site's tree for purge (H2 gating fix 2). fs.rm with
 * force:true only forgives a missing path — permission/traversal
 * errors throw — and the post-delete existence check turns even a
 * partial silent survival into a thrown SiteJobError, so the purge job
 * FAILS on the job row instead of reporting a deletion that did not
 * happen. Exported for tests.
 */
export async function purgeSiteTree(config: PlatformConfig, site: Pick<SiteRow, 'id'>): Promise<void> {
  const dir = siteDir(config, site.id);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    throw new SiteJobError('site_purge_failed', `cannot delete site tree ${dir}: ${(error as Error).message}`);
  }
  if (existsSync(dir)) {
    throw new SiteJobError('site_purge_failed', `site tree survived purge: ${dir}`);
  }
}

/**
 * site.purge (H2 gating fix 2): hosting purge used to rm the tree from
 * the API process — under the non-root cutover that rm silently no-ops
 * against the fenced tree while the row still flips to 'purged'. The
 * worker (root, the sandbox boundary) owns the deletion now: kill the
 * runtime, delete the tree, release the site's UID back to the pool,
 * and only then mark the row purged. Any failure throws and the job
 * ends 'failed' with the site still 'delete_scheduled', so the admin
 * sweep re-enqueues it instead of losing the site. Idempotent: a
 * duplicate job for an already-purged site succeeds as a no-op.
 */
async function runPurge(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow): Promise<void> {
  if (site.status === 'purged') return;
  if (site.runtime_pid) await stopSiteProcess(deps.config, { key: site.id, rowVersion: site.row_version, localPid: site.runtime_pid });
  await purgeSiteTree(deps.config, site);
  await releaseSiteUid(deps.db, site.id);
  await deps.db.query(
    "UPDATE sites SET status = 'purged', subdomain = NULL, purge_at = NULL, runtime_port = NULL, runtime_pid = NULL WHERE id = $1",
    [site.id],
  );
}

/**
 * site.stop (sandbox Phase 1 follow-up): admin suspend used to killPid
 * from the API process — after Phase 1 the site process lives in the
 * site-runner's PID namespace, so the API only flips the row with a
 * row_version bump and enqueues this job. Two producers enqueue it:
 * admin suspend (status 'suspended') and the owner's delete-request
 * (status 'delete_scheduled') — the latter used to flip the status
 * alone, leaving the process running until purge up to 30 days later.
 * The stop is fenced on the exact version: if the site has since been
 * resumed, restarted or un-deleted (status no longer the one the stop
 * was issued for, or a newer row_version), a newer lifecycle action
 * owns the process and this job is a no-op. Only after stopSiteProcess
 * has run are the runtime fields cleared — again guarded on the same
 * version — so a stop can never erase the record of a process a newer
 * action spawned.
 */
async function runStop(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, rowVersion: number | undefined): Promise<void> {
  if ((site.status !== 'suspended' && site.status !== 'delete_scheduled') || rowVersion === undefined || site.row_version !== rowVersion) return;
  await stopSiteProcess(deps.config, { key: site.id, rowVersion, localPid: site.runtime_pid });
  await deps.db.query(
    "UPDATE sites SET runtime_port = NULL, runtime_pid = NULL WHERE id = $1 AND row_version = $2 AND status IN ('suspended', 'delete_scheduled')",
    [site.id, rowVersion],
  );
}

async function listSiteHtmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 6 || out.length >= 500) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/\.html?$/i.test(entry.name)) out.push(full);
    }
  }
  await walk(dir, 0);
  return out.sort();
}

/**
 * site.visual_edit_apply (migration 0046): the worker half of the
 * visual editor for hosted static sites. The router's finalize has
 * ALREADY claimed the one-time setup right before enqueueing this job
 * (claim first, files second — files must never change while the right
 * is unconsumed). This job re-verifies that claim before touching
 * anything: the service task must carry THIS session's visual-editor
 * submission; any other state (the form door won and this job is an
 * orphan, a replay, a hand-crafted enqueue) fails as
 * visual_edit_claim_missing with the tree untouched and no backup
 * taken. Then, strictly in order: a full backup through the normal
 * runBackup path, and only then the exact-match rewrite of every HTML
 * file, using the same match rules the API used to build the candidate
 * set (@3t/core visual-edit: raw + HTML-escaped forms, all
 * occurrences). All new contents are computed in memory first — a
 * total miss fails as visual_edit_no_match BEFORE any file is written,
 * with the pre-edit backup already stored for staff. No restart: the
 * static server reads files per request.
 */
async function runVisualEditApply(
  deps: { config: PlatformConfig; db: Db; store: LocalObjectStore },
  job: JobRow,
  site: SiteRow,
  payload: { task_id?: string; session_id?: string; pairs?: ReplacementPair[] },
): Promise<void> {
  const { config, db } = deps;
  const pairs = (payload.pairs ?? []).filter(
    (p) => p && typeof p.from === 'string' && typeof p.to === 'string' && p.from.length > 0 && p.from !== p.to,
  );
  if (!payload.task_id || !payload.session_id || pairs.length === 0) {
    throw new SiteJobError('visual_edit_bad_payload', 'visual edit apply refused: payload is missing the task, session or replacement pairs');
  }
  const claim = await db.query<{ setup_info_json: { source?: string; session_id?: string } | null; setup_info_submitted_at: Date | null }>(
    'SELECT setup_info_json, setup_info_submitted_at FROM service_tasks WHERE id = $1',
    [payload.task_id],
  );
  const claimed = claim.rows[0];
  if (!claimed?.setup_info_submitted_at || claimed.setup_info_json?.source !== 'visual_editor' || claimed.setup_info_json?.session_id !== payload.session_id) {
    throw new SiteJobError('visual_edit_claim_missing', 'visual edit apply refused: the setup right was not claimed by this edit session');
  }
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO backups (site_id, kind, expires_at) VALUES ($1, 'backup', now() + interval '30 days') RETURNING id",
    [site.id],
  );
  const backupId = inserted.rows[0]!.id;
  await runBackup(deps, job, site, backupId);

  const dir = siteDir(config, site.id);
  const files = await listSiteHtmlFiles(dir);
  const rewritten = new Map<string, string>();
  const totals = new Array<number>(pairs.length).fill(0);
  const corpusParts: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    corpusParts.push(content);
    const result = applyReplacements(content, pairs);
    result.counts.forEach((n, i) => {
      totals[i] = (totals[i] ?? 0) + n;
    });
    if (result.content !== content) rewritten.set(file, result.content);
  }
  const totalReplaced = totals.reduce((sum, n) => sum + n, 0);
  if (totalReplaced === 0) {
    // A retry after a completed apply finds every pair already in
    // place (from gone, to present) — that is success, not a miss.
    const corpus = corpusParts.join('\n');
    const alreadyApplied = pairs.every((p) => countForms(corpus, p.from) === 0 && countForms(corpus, p.to) > 0);
    if (!alreadyApplied) {
      throw new SiteJobError('visual_edit_no_match', 'visual edit apply found none of the finalized strings in the site files (pre-edit backup kept)');
    }
  }
  for (const [file, content] of rewritten) {
    const tmp = `${file}.t3e-tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }
  await setJobResult(db, job, {
    backup_id: backupId,
    files_changed: rewritten.size,
    replacements: totalReplaced,
    pairs_matched: totals.filter((n) => n > 0).length,
    pairs_total: pairs.length,
  });
  await emitEvent(db, 'site.visual_edit_applied', 'site', site.id, { site_id: site.id, backup_id: backupId, replacements: totalReplaced });
}

/** Site job runner: owns job completion like runImportJob (no auto-retry for site jobs). */
export async function runSiteJob(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow): Promise<void> {
  const payload = job.payload_json as { site_id: string; deployment_id?: string; backup_id?: string; version_id?: string; row_version?: number; task_id?: string; session_id?: string; pairs?: ReplacementPair[] };
  const site = await loadSite(deps.db, payload.site_id);
  try {
    if (job.type === 'site.provision') await runProvision(deps, job, site, payload.deployment_id ?? null);
    else if (job.type === 'site.backup') await runBackup(deps, job, site, payload.backup_id!);
    else if (job.type === 'site.restore') await runRestore(deps, job, site, payload.backup_id!, payload.deployment_id ?? null);
    else if (job.type === 'site.update') await runUpdate(deps, job, site, payload.version_id!, payload.deployment_id ?? null);
    else if (job.type === 'site.restart') await runRestart(deps, job, site);
    else if (job.type === 'site.content-backup') await runContentBackup(deps, job, site, payload.backup_id!);
    else if (job.type === 'site.content-restore') await runContentRestore(deps, job, site, payload.backup_id!, payload.deployment_id ?? null);
    else if (job.type === 'site.setup-token') await runSetupToken(deps, job, site);
    else if (job.type === 'site.purge') await runPurge(deps, job, site);
    else if (job.type === 'site.stop') await runStop(deps, job, site, payload.row_version);
    else if (job.type === 'site.visual_edit_apply') await runVisualEditApply(deps, job, site, payload);
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
