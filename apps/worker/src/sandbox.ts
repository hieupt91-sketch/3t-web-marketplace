import { chmod, chown, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db, PlatformConfig } from '@3t/core';
import { killPid } from './runtime-agent.ts';

/**
 * Sandbox Phase 0 (audit C-01) — OS-level fencing for spawned template code.
 *
 * Until now every site/demo/import-check process ran with the worker's (or
 * the API's) own UID inside root containers: template code could read the
 * platform processes' /proc/<pid>/environ (DATABASE_URL, MFA_KEY, …) and
 * every other tenant's data/ on the shared appdata volume. Phase 0 closes
 * those two holes with the cheapest real mechanism (see
 * audit-2026-11-02/sandbox-plan.md §2/§4):
 *
 * - each site gets a dedicated UID from a fixed pool (sites.runtime_uid is
 *   the allocation ledger, migration 0041); demos share one UID and import
 *   runtime checks share another, both distinct from the worker's;
 * - the site tree is fenced to that UID: the tree root is owned by the UID
 *   with the sticky bit + 0700 (the site can enter its own tree, nobody
 *   else can), code stays worker-owned and non-writable, and data/ is
 *   owned by the UID at 0700/0600 so no other tenant can read or write it;
 * - resource limits ride along in spawnServer (prlimit).
 *
 * Network egress is deliberately NOT addressed here — per the plan that
 * needs per-UID nftables in the Phase 1 runner's netns; a proxy env var
 * would be theatre. Probes P4/P5 stay open until Phase 1.
 *
 * Capability gate: setuid spawn and chown fencing require the worker to
 * run as root (true in the production containers). SANDBOX_UID_MODE:
 *   auto (default) — fence when euid is 0, otherwise run unfenced with a
 *                    loud startup warning (dev machines, CI);
 *   on             — refuse to start without euid 0;
 *   off            — never fence (explicit operator choice).
 */

export interface SandboxStatus {
  enabled: boolean;
  reason: string;
}

const statusCache = new WeakMap<PlatformConfig, SandboxStatus>();

export function sandboxStatus(config: PlatformConfig): SandboxStatus {
  const hit = statusCache.get(config);
  if (hit) return hit;
  const euid = process.getuid?.() ?? -1;
  let status: SandboxStatus;
  if (config.sandboxUidMode === 'off') {
    status = { enabled: false, reason: 'SANDBOX_UID_MODE=off' };
  } else if (euid === 0) {
    status = { enabled: true, reason: 'worker runs as root (euid 0)' };
  } else if (config.sandboxUidMode === 'on') {
    throw new Error(`SANDBOX_UID_MODE=on requires the worker to run as root for setuid fencing (euid is ${euid})`);
  } else {
    status = { enabled: false, reason: `worker euid is ${euid}, not root — setuid fencing unavailable in this environment` };
  }
  statusCache.set(config, status);
  return status;
}

/** Loud, greppable startup line: fencing must never silently be off. */
export function logSandboxStatus(config: PlatformConfig, log: (event: string, fields?: Record<string, unknown>) => void): SandboxStatus {
  const status = sandboxStatus(config);
  if (status.enabled) log('sandbox_uid_fencing_enabled', { reason: status.reason, uid_base: config.siteUidBase, pool: config.siteUidPoolSize });
  else log('SANDBOX_UID_FENCING_DISABLED', { reason: status.reason });
  return status;
}

export function sandboxEnabled(config: PlatformConfig): boolean {
  return sandboxStatus(config).enabled;
}

export function siteUidForSlot(config: PlatformConfig, slot: number): number {
  return config.siteUidBase + slot;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/**
 * The site's sandbox UID: the recorded allocation when present, otherwise
 * the lowest free pool slot. Returns null when fencing is disabled (the
 * caller then spawns exactly as before Phase 0). The partial unique index
 * on sites.runtime_uid makes a double allocation impossible; a lost race
 * retries against the fresh allocation set.
 */
export async function allocateSiteUid(db: Db, config: PlatformConfig, siteId: string): Promise<number | null> {
  if (!sandboxEnabled(config)) return null;
  const existing = await db.query<{ runtime_uid: number | null }>('SELECT runtime_uid FROM sites WHERE id = $1', [siteId]);
  if (existing.rows[0]?.runtime_uid) return existing.rows[0].runtime_uid;
  for (let attempt = 0; attempt < 8; attempt++) {
    const used = await db.query<{ runtime_uid: number }>('SELECT runtime_uid FROM sites WHERE runtime_uid IS NOT NULL');
    const taken = new Set(used.rows.map((r) => r.runtime_uid));
    let uid: number | null = null;
    for (let slot = 0; slot < config.siteUidPoolSize; slot++) {
      const candidate = siteUidForSlot(config, slot);
      if (!taken.has(candidate)) {
        uid = candidate;
        break;
      }
    }
    if (uid === null) throw new Error(`site UID pool exhausted (${config.siteUidPoolSize} slots from ${config.siteUidBase})`);
    try {
      const updated = await db.query('UPDATE sites SET runtime_uid = $2 WHERE id = $1 AND runtime_uid IS NULL', [siteId, uid]);
      if ((updated.rowCount ?? 0) === 1) return uid;
      // A concurrent allocator fenced this same site first; take its UID.
      const now = await db.query<{ runtime_uid: number | null }>('SELECT runtime_uid FROM sites WHERE id = $1', [siteId]);
      if (now.rows[0]?.runtime_uid) return now.rows[0].runtime_uid;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another site won this slot between our read and write; retry fresh.
    }
  }
  throw new Error(`could not allocate a sandbox UID for site ${siteId}`);
}

export async function releaseSiteUid(db: Db, siteId: string): Promise<void> {
  await db.query('UPDATE sites SET runtime_uid = NULL WHERE id = $1', [siteId]);
}

/* ------------------------------ fencing ------------------------------ */

/**
 * The spawned child reaches its tree by path, so every ancestor up to
 * the workDir root needs the execute bit for "other" — nothing more
 * (no read: a site cannot list sibling names, only traverse to its own).
 * Production images create these dirs 0755 and this is a no-op; a worker
 * started under a tight umask (027/007) would otherwise produce
 * 0750/0770 parents and the fenced child could not even chdir — an
 * exec failure that looks like a template crash. Only ever ADDS o+x.
 */
async function ensureOtherExecute(path: string): Promise<void> {
  const mode = (await lstat(path)).mode & 0o7777;
  if ((mode & 0o001) === 0) await chmod(path, mode | 0o001);
}

async function ensureTraversableTo(dir: string, boundary: string): Promise<void> {
  let current = dirname(dir);
  for (;;) {
    await ensureOtherExecute(current);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function walkEntries(root: string, visit: (path: string, isDir: boolean) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await visit(full, true);
      await walkEntries(full, visit);
    } else if (entry.isFile()) {
      await visit(full, false);
    }
  }
}

/** Code stays worker-owned (uid 0), readable/executable by the site, never writable by it. */
async function fenceCodePath(path: string, isDir: boolean): Promise<void> {
  await chown(path, 0, 0);
  const mode = (await lstat(path)).mode & 0o777;
  await chmod(path, (mode & ~0o022) | (isDir ? 0o005 : 0o004));
}

/** The tenant's own writable tree: owned by its UID, invisible to everyone else. */
async function fenceDataPath(uid: number, gid: number): Promise<(path: string, isDir: boolean) => Promise<void>> {
  return async (path, isDir) => {
    await chown(path, uid, gid);
    await chmod(path, isDir ? 0o700 : 0o600);
  };
}

async function fenceTree(config: PlatformConfig, dir: string, uid: number): Promise<boolean> {
  if (!sandboxEnabled(config)) return false;
  const gid = config.siteGid;
  const dataDir = join(dir, 'data');
  await ensureTraversableTo(dir, config.workDir);
  await mkdir(join(dataDir, '.tmp'), { recursive: true });
  // Tree root: owned by the site's UID, sticky + owner-only. The site can
  // enter and create files, but the sticky bit stops it deleting or
  // replacing worker-owned code entries, and 0700 shuts every other
  // tenant (different UID) out of the whole tree.
  await chown(dir, uid, gid);
  await chmod(dir, 0o1700);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === 'data') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await fenceCodePath(full, true);
      await walkEntries(full, fenceCodePath);
    } else if (entry.isFile()) {
      await fenceCodePath(full, false);
    }
  }
  await chown(dataDir, uid, gid);
  await chmod(dataDir, 0o700);
  await walkEntries(dataDir, await fenceDataPath(uid, gid));
  return true;
}

/** Fence a customer site's tree to its allocated UID. No-op (false) when fencing is off. */
export async function fenceSiteTree(config: PlatformConfig, dir: string, uid: number): Promise<boolean> {
  return fenceTree(config, dir, uid);
}

/** Fence a demo session's tree to the shared demo UID. */
export async function fenceDemoTree(config: PlatformConfig, dir: string): Promise<boolean> {
  return fenceTree(config, dir, config.demoUid);
}

/**
 * Import runtime checks run in a throwaway workspace: the whole runtime
 * tree is handed to the import UID (the template legitimately writes its
 * own data during the check) and the workspace root is owner-only.
 */
export async function fenceImportTree(config: PlatformConfig, dir: string): Promise<boolean> {
  if (!sandboxEnabled(config)) return false;
  await ensureTraversableTo(dir, config.workDir);
  await chown(dir, config.importUid, config.siteGid);
  await chmod(dir, 0o755);
  await walkEntries(dir, async (path, isDir) => {
    await chown(path, config.importUid, config.siteGid);
    await chmod(path, isDir ? 0o755 : 0o644);
  });
  return true;
}

/* ------------------------------ reapers ------------------------------ */

/**
 * Orphan reaping by recorded runtime_pid (plan Phase 0 item 3): processes
 * whose DB record says they should no longer exist get killed by the
 * worker — the only platform process that shares a pid namespace with
 * them. This also covers the API-side lifecycle actions (demo cancel /
 * expire, site purge) whose own killPid cannot reach across containers.
 * The site directory lifecycle is untouched: a purged site keeps its tree
 * on disk exactly as before, only its process and UID allocation go away.
 */
export async function reapOrphanProcesses(db: Db): Promise<{ demos: number; sites: number }> {
  let demos = 0;
  const deadDemos = await db.query<{ id: string; runtime_pid: number | null }>(
    "SELECT id, runtime_pid FROM demo_sessions WHERE status IN ('expired', 'cancelled') AND runtime_pid IS NOT NULL",
  );
  for (const row of deadDemos.rows) {
    killPid(row.runtime_pid);
    await db.query('UPDATE demo_sessions SET runtime_pid = NULL, runtime_port = NULL WHERE id = $1', [row.id]);
    demos++;
  }
  let sites = 0;
  const deadSites = await db.query<{ id: string; runtime_pid: number | null }>(
    "SELECT id, runtime_pid FROM sites WHERE status = 'purged' AND (runtime_pid IS NOT NULL OR runtime_uid IS NOT NULL)",
  );
  for (const row of deadSites.rows) {
    killPid(row.runtime_pid);
    await db.query('UPDATE sites SET runtime_pid = NULL, runtime_port = NULL, runtime_uid = NULL WHERE id = $1', [row.id]);
    sites++;
  }
  return { demos, sites };
}
