import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { get as httpGet } from 'node:http';
import { hashToken, previewOrigin, randomToken, writeAudit, type Db, type PlatformConfig } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

interface VersionRow {
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

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function httpStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function killPid(pid: number | null): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000).unref?.();
  } catch {
    /* already gone */
  }
}

/** Spawn a runtime bundle for a demo session (dev/local runtime; see M5 for the agent). */
async function spawnDemoServer(
  deps: { db: Db; store: { pathFor: (key: string) => string }; config: PlatformConfig },
  sessionId: string,
  version: VersionRow,
): Promise<{ port: number; pid: number }> {
  const dir = join(deps.config.workDir, 'demo-sessions', sessionId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(deps.store.pathFor(version.artifact_key), dir, { recursive: true, dereference: false });
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
  const port = await freePort();
  const start = version.manifest_json.runtime?.start ?? ['node', 'server.js'];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' };
  for (const item of version.manifest_json.env ?? []) {
    if (item.scope === 'public' && item.defaultValue !== undefined) env[item.name] = item.defaultValue;
  }
  const proc: ChildProcess = spawn(start[0]!, start.slice(1), { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', () => undefined);
  proc.stderr?.on('data', () => undefined);
  const healthPath = version.manifest_json.runtime?.healthPath ?? '/';
  let ok = false;
  for (let attempt = 0; attempt < 20 && !ok; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (proc.exitCode !== null) break;
    ok = (await httpStatus(port, healthPath)) === 200;
  }
  if (!ok) {
    killPid(proc.pid ?? null);
    throw errors.badRequest('demo.spawn_failed');
  }
  return { port, pid: proc.pid ?? 0 };
}

/** Mark overdue sessions expired and stop their runtime servers (best effort). */
async function sweepExpired(db: Db): Promise<void> {
  const { rows } = await db.query<{ id: string; runtime_pid: number | null }>(
    "SELECT id, runtime_pid FROM demo_sessions WHERE status = 'active' AND expires_at <= now()",
  );
  for (const row of rows) killPid(row.runtime_pid);
  await db.query("UPDATE demo_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= now()");
}

async function loadSession(db: Db, id: string) {
  await sweepExpired(db);
  const { rows } = await db.query<{
    id: string; version_id: string; preview_label: string | null; runtime_port: number | null; status: string;
    admin_token_expires_at: Date | null; expires_at: Date; created_at: Date;
  }>(
    'SELECT id, version_id, preview_label, runtime_port, status, admin_token_expires_at, expires_at, created_at FROM demo_sessions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

function sessionUrl(config: PlatformConfig, row: { preview_label: string | null; runtime_port: number | null }): string | null {
  if (row.runtime_port) return `http://127.0.0.1:${row.runtime_port}/`;
  if (row.preview_label) return `${previewOrigin(config, row.preview_label)}/`;
  return null;
}

/**
 * D02–D04 demo sessions (docs/03 §8).
 * Static adapters reuse the version's active preview (a dedicated preview row per
 * session is impossible: previews are unique-active per import); the session page
 * itself enforces expiry, while the underlying preview URL is only reachable to
 * holders of its random label. Runtime adapters get a fully session-scoped server.
 * Admin-launch tokens are demo-only affordances: demo apps do not validate them
 * against real accounts (documented in PROJECT_STATUS).
 */
export async function demoSessionRoutes(app: FastifyInstance): Promise<void> {
  const { db, store, config } = app.deps;

  app.post<{ Body: { version_id: string } }>(
    '/demo-sessions',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { body: { type: 'object', additionalProperties: false, required: ['version_id'], properties: { version_id: { type: 'string', pattern: UUID.source } } } } },
    async (request, reply) => {
      await sweepExpired(db);
      const active = await db.query<{ n: string }>("SELECT count(*) AS n FROM demo_sessions WHERE status = 'active'");
      if (Number(active.rows[0]!.n) >= config.demoMaxActiveSessions) throw errors.tooMany(60);
      const version = await db.query<VersionRow>(
        `SELECT v.id, v.template_id, v.adapter, v.manifest_json, v.artifact_id, a.object_key AS artifact_key
         FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1`,
        [request.body.version_id],
      );
      const v = version.rows[0];
      if (!v) throw errors.notFound();
      const ttlHours = Math.min(72, Math.max(1, v.manifest_json.demo?.ttlHours ?? 2));
      const isRuntime = v.adapter === 'node-http' || v.adapter === 'next-standalone';
      let previewLabel: string | null = null;
      let runtimePort: number | null = null;
      let runtimePid: number | null = null;
      if (!isRuntime) {
        const preview = await db.query<{ host_label: string }>(
          "SELECT host_label FROM previews WHERE version_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          [v.id],
        );
        if (!preview.rows[0]) throw errors.conflict('demo.unavailable');
        previewLabel = preview.rows[0]!.host_label;
      }
      const created = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO demo_sessions (version_id, preview_label, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING id, expires_at`,
        [v.id, previewLabel, ttlHours],
      );
      const sessionId = created.rows[0]!.id;
      if (isRuntime) {
        try {
          const spawned = await spawnDemoServer({ db, store, config }, sessionId, v);
          runtimePort = spawned.port;
          runtimePid = spawned.pid;
          await db.query('UPDATE demo_sessions SET runtime_port = $2, runtime_pid = $3 WHERE id = $1', [sessionId, runtimePort, runtimePid]);
        } catch (error) {
          await db.query("UPDATE demo_sessions SET status = 'cancelled' WHERE id = $1", [sessionId]);
          throw error;
        }
      }
      const url = sessionUrl(config, { preview_label: previewLabel, runtime_port: runtimePort });
      return reply.status(201).send({ data: { id: sessionId, version_id: v.id, url, admin_url: null, status: 'active', expires_at: created.rows[0]!.expires_at.toISOString() } });
    },
  );

  app.get<{ Params: { id: string } }>('/demo-sessions/:id', async (request) => {
    assertId(request.params.id);
    const row = await loadSession(db, request.params.id);
    if (!row) throw errors.notFound();
    const adminLaunched = row.admin_token_expires_at !== null && row.admin_token_expires_at > new Date();
    const base = sessionUrl(config, row);
    const tpl = await db.query<{ slug: string }>(
      'SELECT t.slug FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE v.id = $1',
      [row.version_id],
    );
    return {
      data: {
        id: row.id, version_id: row.version_id, template_slug: tpl.rows[0]?.slug ?? null, url: row.status === 'active' ? base : null,
        admin_url: row.status === 'active' && adminLaunched && base ? `${base.replace(/\/$/, '')}/admin` : null,
        admin_launched: adminLaunched, status: row.status,
        expires_at: row.expires_at.toISOString(), created_at: row.created_at.toISOString(),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/demo-sessions/:id/admin-launch', async (request, reply) => {
    assertId(request.params.id);
    const row = await loadSession(db, request.params.id);
    if (!row) throw errors.notFound();
    if (row.status !== 'active') throw errors.conflict('demo.not_active');
    const version = await db.query<{ manifest_json: VersionRow['manifest_json'] }>('SELECT manifest_json FROM template_versions WHERE id = $1', [row.version_id]);
    if (version.rows[0]!.manifest_json.demo?.mode !== 'isolatedAdmin') throw errors.conflict('demo.no_admin');
    const token = randomToken();
    await db.query(
      'UPDATE demo_sessions SET admin_token_hash = $2, admin_token_expires_at = now() + interval \'10 minutes\' WHERE id = $1',
      [request.params.id, hashToken(token)],
    );
    const base = sessionUrl(config, row);
    return reply.status(201).send({ data: { admin_url: base ? `${base.replace(/\/$/, '')}/admin` : null, token, token_expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } });
  });

  app.post<{ Params: { id: string } }>('/demo-sessions/:id/reset', async (request) => {
    assertId(request.params.id);
    const row = await loadSession(db, request.params.id);
    if (!row) throw errors.notFound();
    if (row.status !== 'active') throw errors.conflict('demo.not_active');
    if (row.runtime_port) {
      killPid((await db.query<{ runtime_pid: number | null }>('SELECT runtime_pid FROM demo_sessions WHERE id = $1', [row.id])).rows[0]!.runtime_pid);
      const version = await db.query<VersionRow>(
        `SELECT v.id, v.template_id, v.adapter, v.manifest_json, v.artifact_id, a.object_key AS artifact_key
         FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1`,
        [row.version_id],
      );
      const spawned = await spawnDemoServer({ db, store, config }, row.id, version.rows[0]!);
      await db.query('UPDATE demo_sessions SET runtime_port = $2, runtime_pid = $3, admin_token_hash = NULL, admin_token_expires_at = NULL WHERE id = $1', [row.id, spawned.port, spawned.pid]);
    } else {
      await db.query('UPDATE demo_sessions SET admin_token_hash = NULL, admin_token_expires_at = NULL WHERE id = $1', [row.id]);
    }
    const fresh = await loadSession(db, row.id);
    return { data: { id: row.id, url: sessionUrl(config, fresh!), status: fresh!.status, expires_at: fresh!.expires_at.toISOString() } };
  });

  app.post<{ Params: { id: string } }>('/demo-sessions/:id/cancel', async (request) => {
    assertId(request.params.id);
    const row = await db.query<{ runtime_pid: number | null; preview_label: string | null }>('SELECT runtime_pid, preview_label FROM demo_sessions WHERE id = $1', [request.params.id]);
    if (!row.rows[0]) throw errors.notFound();
    killPid(row.rows[0]!.runtime_pid);
    await db.query("UPDATE demo_sessions SET status = 'cancelled' WHERE id = $1", [request.params.id]);
    await writeAudit(db, { actorType: 'user', actorId: null, action: 'demo.cancelled', resourceType: 'demo_session', resourceId: request.params.id, traceId: request.id });
    return { data: { id: request.params.id, status: 'cancelled' } };
  });
}

/** A17 — admin demo oversight (list + expire). */
export async function adminDemoRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/demos', async (request) => {
    requirePermission(request, 'ops:read');
    await sweepExpired(db);
    const { rows } = await db.query<{ id: string; version_id: string; status: string; runtime_port: number | null; expires_at: Date; created_at: Date }>(
      'SELECT id, version_id, status, runtime_port, expires_at, created_at FROM demo_sessions ORDER BY created_at DESC LIMIT 100',
    );
    return {
      data: rows.map((r) => ({ id: r.id, version_id: r.version_id, status: r.status, runtime_port: r.runtime_port, url: r.status === 'active' ? sessionUrl(config, { preview_label: null, runtime_port: r.runtime_port }) : null, expires_at: r.expires_at.toISOString(), created_at: r.created_at.toISOString() })),
    };
  });

  app.post<{ Params: { id: string } }>('/demos/:id/expire', async (request) => {
    requirePermission(request, 'ops:execute');
    assertId(request.params.id);
    const row = await db.query<{ runtime_pid: number | null }>('SELECT runtime_pid FROM demo_sessions WHERE id = $1', [request.params.id]);
    if (!row.rows[0]) throw errors.notFound();
    killPid(row.rows[0]!.runtime_pid);
    await db.query("UPDATE demo_sessions SET status = 'expired' WHERE id = $1", [request.params.id]);
    return { data: { id: request.params.id, status: 'expired' } };
  });
}
