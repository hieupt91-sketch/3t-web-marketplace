import { chmod, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import {
  DEMO_ADMIN_PASSWORD,
  DEMO_ADMIN_USERNAME,
  completeJob,
  failJob,
  type Db,
  type JobRow,
  type LocalObjectStore,
  type PlatformConfig,
} from '@3t/core';
import { killPid, siteLimitsOf, spawnServer } from './runtime-agent.ts';
import { fenceDemoTree, sandboxEnabled } from './sandbox.ts';

/**
 * Demo-session runtime jobs (sandbox Phase 0, audit C-01 item 4).
 *
 * Demo sessions are the one place anonymous visitors cause template code
 * to execute, and until now the API process spawned it itself — sharing a
 * process (and, in production, a container) with session auth, step-up
 * and every admin route. The API now only records intent (demo.spawn /
 * demo.stop jobs); all template execution lives here in the worker, under
 * the shared demo UID with the same fencing + prlimit caps as real sites.
 * The site router reaches the spawned servers at the worker host
 * (SITE_ROUTER_SESSIONS_HOST=worker), so the move is invisible outside.
 */
export const DEMO_JOB_TYPES = ['demo.spawn', 'demo.stop'] as const;

interface DemoVersionRow {
  id: string;
  template_id: string;
  adapter: string;
  manifest_json: {
    demo?: { mode?: string; ttlHours?: number };
    runtime?: { start?: string[]; healthPath?: string };
    env?: { name: string; scope: string; defaultValue?: string }[];
  };
  artifact_id: string;
  artifact_key: string;
}

interface DemoSessionRow {
  id: string;
  version_id: string;
  status: string;
  runtime_port: number | null;
  runtime_pid: number | null;
}

async function loadSession(db: Db, id: string): Promise<DemoSessionRow | null> {
  const { rows } = await db.query<DemoSessionRow>('SELECT id, version_id, status, runtime_port, runtime_pid FROM demo_sessions WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function loadVersion(db: Db, id: string): Promise<DemoVersionRow> {
  const { rows } = await db.query<DemoVersionRow>(
    `SELECT v.id, v.template_id, v.adapter, v.manifest_json, v.artifact_id, a.object_key AS artifact_key
     FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`demo version not found: ${id}`);
  return rows[0]!;
}

function httpFormPost(port: number, path: string, fields: Record<string, string>): Promise<{ status: number; setCookie: boolean }> {
  return new Promise((resolve) => {
    const body = new URLSearchParams(fields).toString();
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }, timeout: 5000 },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: Boolean(res.headers['set-cookie']?.length) }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, setCookie: false }));
    req.end(body);
  });
}

/**
 * Seed the demo admin account into a freshly spawned session copy, using
 * the template family's own first-run setup flow: the app writes a one-time
 * setup token to data/setup-token.txt when it boots without an admin, and
 * POST /admin/setup creates the account. Best effort by design — any
 * mismatch (a different bootstrap, an admin already present) leaves the
 * demo viewable exactly as before, just without a login-able admin.
 * (Moved verbatim from the API's demo-sessions route; it runs here now
 * because only the worker is local to the spawned process.)
 */
async function seedDemoAdmin(config: PlatformConfig, sessionId: string, version: DemoVersionRow, port: number): Promise<boolean> {
  try {
    if (version.manifest_json.demo?.mode !== 'isolatedAdmin') return false;
    const tokenFile = join(config.workDir, 'demo-sessions', sessionId, 'data', 'setup-token.txt');
    let token = '';
    for (let attempt = 0; attempt < 10 && !token; attempt++) {
      token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
      if (!token) await new Promise((r) => setTimeout(r, 300));
    }
    if (!token) return false;
    const setup = await httpFormPost(port, '/admin/setup', { token, username: DEMO_ADMIN_USERNAME, password: DEMO_ADMIN_PASSWORD });
    if (![301, 302, 303].includes(setup.status)) return false;
    const login = await httpFormPost(port, '/admin/login', { username: DEMO_ADMIN_USERNAME, password: DEMO_ADMIN_PASSWORD });
    return [301, 302, 303].includes(login.status) && login.setCookie;
  } catch {
    return false;
  }
}

async function runSpawn(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, sessionId: string, expectPid: number | null): Promise<void> {
  const { config, db, store } = deps;
  const session = await loadSession(db, sessionId);
  if (!session) return;
  // A stop/cancel may have landed while this job waited: never resurrect.
  if (session.status !== 'active') {
    killPid(session.runtime_pid ?? expectPid);
    return;
  }
  if (expectPid) killPid(expectPid);
  if (session.runtime_pid && session.runtime_pid !== expectPid) killPid(session.runtime_pid);
  try {
    const version = await loadVersion(db, session.version_id);
    const dir = join(config.workDir, 'demo-sessions', sessionId);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await cp(store.pathFor(version.artifact_key), dir, { recursive: true, dereference: false });
    const makeWritable = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          await chmod(full, 0o755);
          await makeWritable(full);
        } else if (entry.isFile()) await chmod(full, 0o644);
      }
    };
    await chmod(dir, 0o755);
    await makeWritable(dir);
    await fenceDemoTree(config, dir);
    const env: Record<string, string> = {};
    for (const item of version.manifest_json.env ?? []) {
      if (item.scope === 'public' && item.defaultValue !== undefined) env[item.name] = item.defaultValue;
    }
    const spawned = await spawnServer(config, {
      kind: 'runtime',
      dir,
      start: version.manifest_json.runtime?.start ?? ['node', 'server.js'],
      healthPath: version.manifest_json.runtime?.healthPath ?? '/',
      env,
      limits: siteLimitsOf(config),
      writableDir: join(dir, 'data'),
      ...(sandboxEnabled(config) ? { uid: config.demoUid, gid: config.siteGid } : {}),
    });
    // Cancelled while spawning/seeding: tear down instead of publishing.
    const during = await loadSession(db, sessionId);
    if (!during || during.status !== 'active') {
      killPid(spawned.pid);
      return;
    }
    const demoAdminReady = await seedDemoAdmin(config, sessionId, version, spawned.port);
    const after = await loadSession(db, sessionId);
    if (!after || after.status !== 'active') {
      killPid(spawned.pid);
      return;
    }
    // Port, pid and admin readiness land in ONE update: the API's create
    // flow waits for runtime_port and must never observe a half-seeded
    // session as ready.
    await db.query('UPDATE demo_sessions SET runtime_port = $2, runtime_pid = $3, demo_admin_ready = $4 WHERE id = $1', [
      sessionId,
      spawned.port,
      spawned.pid,
      demoAdminReady,
    ]);
  } catch (error) {
    // Mirror the old in-API behaviour: a failed spawn cancels the session,
    // which the API's waiting create/reset call surfaces as demo.spawn_failed.
    console.log(JSON.stringify({ event: 'demo_spawn_failed', session_id: sessionId, error: (error as Error).message }));
    await db.query(
      "UPDATE demo_sessions SET status = 'cancelled', runtime_port = NULL, runtime_pid = NULL WHERE id = $1 AND status = 'active'",
      [sessionId],
    );
  }
}

async function runStop(deps: { config: PlatformConfig; db: Db }, sessionId: string, pid: number | null): Promise<void> {
  const { db } = deps;
  const session = await loadSession(db, sessionId);
  killPid(pid ?? session?.runtime_pid ?? null);
  // Only clear the runtime fields of a session that is actually over; a
  // stray stop must never blank a live session's routing.
  await db.query("UPDATE demo_sessions SET runtime_pid = NULL, runtime_port = NULL WHERE id = $1 AND status <> 'active'", [sessionId]);
}

/** Demo job runner: owns job completion like runSiteJob (no auto-retry). */
export async function runDemoJob(deps: { config: PlatformConfig; db: Db; store: LocalObjectStore }, job: JobRow): Promise<void> {
  const payload = job.payload_json as { session_id: string; expect_pid?: number | null; pid?: number | null };
  try {
    if (job.type === 'demo.spawn') await runSpawn(deps, payload.session_id, payload.expect_pid ?? null);
    else if (job.type === 'demo.stop') await runStop(deps, payload.session_id, payload.pid ?? null);
    else throw new Error(`unknown demo job type: ${job.type}`);
    await completeJob(deps.db, job);
  } catch (error) {
    await failJob(deps.db, job, 'demo_job_failed', false);
  }
}
