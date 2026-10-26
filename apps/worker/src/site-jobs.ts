import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import {
  completeJob,
  emitEvent,
  failJob,
  type Db,
  type JobRow,
  type LocalObjectStore,
  type PlatformConfig,
} from '@3t/core';
import { httpStatus, killPid, spawnServer, writeSiteMeta } from './runtime-agent.ts';

export const SITE_JOB_TYPES = ['site.provision', 'site.backup', 'site.restore', 'site.update', 'site.restart'] as const;

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

async function spawnAndRecord(config: PlatformConfig, db: Db, site: SiteRow, version: VersionRow, dir: string): Promise<void> {
  const spawned = await spawnServer(config, spawnSpec(version, dir));
  await db.query('UPDATE sites SET runtime_kind = $2, runtime_port = $3, runtime_pid = $4 WHERE id = $1', [
    site.id,
    spawnSpec(version, dir).kind,
    spawned.port,
    spawned.pid,
  ]);
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

async function runRestore(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, backupId: string, deploymentId: string | null): Promise<void> {
  const { db, store } = deps;
  const backup = await db.query<{ artifact_key: string }>(
    `SELECT a.object_key AS artifact_key FROM backups b JOIN artifacts a ON a.id = b.artifact_id WHERE b.id = $1 AND b.status = 'succeeded'`,
    [backupId],
  );
  if (!backup.rows[0]) throw new Error('backup not restorable');
  const tmp = await mkdtemp(join(tmpdir(), 'mp-restore-'));
  try {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
    const staged = join(tmp, 'staged');
    await mkdir(staged, { recursive: true });
    await execFileAsync('unzip', ['-q', store.pathFor(backup.rows[0]!.artifact_key), '-d', staged], tmp);
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

async function runUpdate(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow, versionId: string, deploymentId: string | null): Promise<void> {
  const { db, store } = deps;
  const version = await loadVersion(db, versionId);
  const tmp = await mkdtemp(join(tmpdir(), 'mp-update-'));
  try {
    if (deploymentId) await db.query("UPDATE deployments SET status = 'running' WHERE id = $1", [deploymentId]);
    const staged = join(tmp, 'staged');
    await materialize(store, version, staged);
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

async function runRestart(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow, site: SiteRow): Promise<void> {
  const { config, db } = deps;
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
    else throw new Error(`unknown site job type: ${job.type}`);
    await completeJob(deps.db, job);
  } catch (error) {
    // Business failure is recorded on the job/site rows (provision_failed etc.);
    // like runImportJob, the runner does not rethrow it. LeaseLostError from
    // failJob still propagates so another worker's ownership is respected.
    await failJob(deps.db, job, 'site_job_failed', false);
  }
}

export { httpStatus };
