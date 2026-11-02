import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DEMO_ADMIN_PASSWORD,
  DEMO_ADMIN_USERNAME,
  enqueueJob,
  hashToken,
  previewOrigin,
  randomToken,
  writeAudit,
  type Db,
  type PlatformConfig,
} from '@3t/core';
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

/**
 * Demo runtime execution lives in the WORKER, never in this process
 * (sandbox Phase 0, audit C-01): the API used to spawn template code
 * itself, sharing a process with session auth and every admin route.
 * The API now records intent as jobs — demo.spawn / demo.stop — and the
 * worker performs the spawn (shared demo UID, fenced tree, prlimit caps)
 * and the kill. The site router proxies session traffic to the worker
 * host, so visitors see no difference.
 */
async function enqueueDemoSpawn(db: Db, sessionId: string, expectPid: number | null): Promise<void> {
  await enqueueJob(db, {
    type: 'demo.spawn',
    dedupeKey: `demo.spawn:${sessionId}:${randomBytes(6).toString('hex')}`,
    payload: { session_id: sessionId, expect_pid: expectPid },
    resourceType: 'demo_session',
    resourceId: sessionId,
    maxAttempts: 1,
  });
}

async function enqueueDemoStop(db: Db, sessionId: string, pid: number | null): Promise<void> {
  await enqueueJob(db, {
    type: 'demo.stop',
    dedupeKey: `demo.stop:${sessionId}:${randomBytes(6).toString('hex')}`,
    payload: { session_id: sessionId, pid },
    resourceType: 'demo_session',
    resourceId: sessionId,
    maxAttempts: 1,
  });
}

/**
 * Wait for the worker to publish the spawned session's runtime port. The
 * worker writes port + pid + demo_admin_ready in one update, so a visible
 * port means the session is fully ready (admin seeded). A session that
 * leaves 'active' underneath us means the spawn failed (the worker
 * cancels it, mirroring the old in-process behaviour), and a timeout
 * cancels the session rather than leaving a zombie behind.
 */
async function waitForDemoRuntime(db: Db, config: PlatformConfig, sessionId: string): Promise<number> {
  const deadline = Date.now() + config.demoSpawnWaitMs;
  for (;;) {
    const { rows } = await db.query<{ runtime_port: number | null; status: string }>(
      'SELECT runtime_port, status FROM demo_sessions WHERE id = $1',
      [sessionId],
    );
    const row = rows[0];
    if (row?.runtime_port) return row.runtime_port;
    if (!row || row.status !== 'active') throw errors.badRequest('demo.spawn_failed');
    if (Date.now() > deadline) {
      await db.query("UPDATE demo_sessions SET status = 'cancelled' WHERE id = $1 AND status = 'active'", [sessionId]);
      await enqueueDemoStop(db, sessionId, null);
      throw errors.badRequest('demo.spawn_failed');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Anonymous demo ownership (audit UI-HIGH-01 / code M-04): creating a
 * demo mints a random bearer token delivered as an HttpOnly cookie;
 * the session row stores only its SHA-256 hash. Lifecycle actions
 * (reset / cancel / admin-launch) require presenting the token — via
 * the cookie (same-origin browser flow) or the x-demo-owner-token
 * header — and a mismatch is answered with the same 404 as a missing
 * session, so the endpoint never confirms a session exists.
 */
export const DEMO_OWNER_COOKIE = 'mp_demo_owner';
const RESET_COOLDOWN_MS = 30_000;

function demoOwnerToken(request: FastifyRequest): string | null {
  const header = request.headers['x-demo-owner-token'];
  if (typeof header === 'string' && header.length >= 16 && header.length <= 128) return header;
  const cookie = request.cookies?.[DEMO_OWNER_COOKIE];
  return typeof cookie === 'string' && cookie.length >= 16 && cookie.length <= 128 ? cookie : null;
}

function requireSessionOwner(request: FastifyRequest, row: { owner_token_hash: Buffer | null }): void {
  const token = demoOwnerToken(request);
  if (!token || !row.owner_token_hash || !hashToken(token).equals(row.owner_token_hash)) throw errors.notFound();
}

/** Mark overdue sessions expired; the worker stops their servers (demo.stop jobs + its orphan reaper). */
async function sweepExpired(db: Db): Promise<void> {
  const { rows } = await db.query<{ id: string; runtime_pid: number | null }>(
    "UPDATE demo_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= now() RETURNING id, runtime_pid",
  );
  for (const row of rows) await enqueueDemoStop(db, row.id, row.runtime_pid);
}

async function loadSession(db: Db, id: string) {
  await sweepExpired(db);
  const { rows } = await db.query<{
    id: string; version_id: string; preview_label: string | null; runtime_port: number | null; status: string;
    admin_token_expires_at: Date | null; demo_admin_ready: boolean; expires_at: Date; created_at: Date;
    owner_token_hash: Buffer | null; last_reset_at: Date | null;
  }>(
    'SELECT id, version_id, preview_label, runtime_port, status, admin_token_expires_at, demo_admin_ready, expires_at, created_at, owner_token_hash, last_reset_at FROM demo_sessions WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

function sessionUrl(config: PlatformConfig, row: { id?: string; preview_label: string | null; runtime_port: number | null }): string | null {
  if (row.runtime_port) {
    // Path-mode preview origin (production): runtime demo servers are reached
    // through the site router's session proxy on the preview origin — never
    // hand visitors a loopback URL, which would point at their own machine.
    if (row.id && config.previewOriginTemplate.endsWith('/{label}')) {
      return `${config.previewOriginTemplate.replace('{label}', `session/${row.id}`)}/`;
    }
    return `http://127.0.0.1:${row.runtime_port}/`;
  }
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
  const { db, config } = app.deps;

  app.post<{ Body: { version_id: string } }>(
    '/demo-sessions',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } }, schema: { body: { type: 'object', additionalProperties: false, required: ['version_id'], properties: { version_id: { type: 'string', pattern: UUID.source } } } } },
    async (request, reply) => {
      await sweepExpired(db);
      const active = await db.query<{ n: string }>("SELECT count(*) AS n FROM demo_sessions WHERE status = 'active'");
      if (Number(active.rows[0]!.n) >= config.demoMaxActiveSessions) throw errors.tooMany(60);
      const version = await db.query<VersionRow>(
        `SELECT v.id, v.template_id, v.adapter, v.manifest_json, v.artifact_id, a.object_key AS artifact_key
         FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id
         JOIN templates t ON t.id = v.template_id
         WHERE v.id = $1 AND v.status = 'published' AND t.status = 'published'`,
        [request.body.version_id],
      );
      const v = version.rows[0];
      if (!v) throw errors.notFound();
      const ttlHours = Math.min(72, Math.max(1, v.manifest_json.demo?.ttlHours ?? 2));
      const isRuntime = v.adapter === 'node-http' || v.adapter === 'next-standalone';
      let previewLabel: string | null = null;
      let runtimePort: number | null = null;
      if (!isRuntime) {
        const preview = await db.query<{ host_label: string }>(
          "SELECT host_label FROM previews WHERE version_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          [v.id],
        );
        if (!preview.rows[0]) throw errors.conflict('demo.unavailable');
        previewLabel = preview.rows[0]!.host_label;
      }
      // Bind the session to this browser's anonymous owner identity;
      // mint one when the browser does not present it yet.
      let ownerToken = demoOwnerToken(request);
      const freshOwnerToken = !ownerToken;
      if (!ownerToken) ownerToken = randomToken();
      const created = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO demo_sessions (version_id, preview_label, expires_at, owner_token_hash) VALUES ($1, $2, now() + make_interval(hours => $3), $4) RETURNING id, expires_at`,
        [v.id, previewLabel, ttlHours, hashToken(ownerToken)],
      );
      const sessionId = created.rows[0]!.id;
      let demoAdminReady = false;
      if (isRuntime) {
        // The worker spawns the session server (and seeds its demo admin);
        // this request waits until the runtime port is published.
        await enqueueDemoSpawn(db, sessionId, null);
        runtimePort = await waitForDemoRuntime(db, config, sessionId);
        const ready = await db.query<{ demo_admin_ready: boolean }>('SELECT demo_admin_ready FROM demo_sessions WHERE id = $1', [sessionId]);
        demoAdminReady = ready.rows[0]?.demo_admin_ready ?? false;
      }
      const url = sessionUrl(config, { id: sessionId, preview_label: previewLabel, runtime_port: runtimePort });
      if (freshOwnerToken) {
        reply.setCookie(DEMO_OWNER_COOKIE, ownerToken, {
          path: '/', httpOnly: true, sameSite: 'lax',
          secure: config.env === 'production', maxAge: 30 * 24 * 3600,
        });
      }
      return reply.status(201).send({ data: { id: sessionId, version_id: v.id, url, admin_url: null, demo_admin: demoAdminReady ? { username: DEMO_ADMIN_USERNAME, password: DEMO_ADMIN_PASSWORD } : null, status: 'active', expires_at: created.rows[0]!.expires_at.toISOString() } });
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
        demo_admin: row.status === 'active' && row.demo_admin_ready && base
          ? { username: DEMO_ADMIN_USERNAME, password: DEMO_ADMIN_PASSWORD, login_url: `${base.replace(/\/$/, '')}/admin` }
          : null,
        admin_launched: adminLaunched, status: row.status,
        expires_at: row.expires_at.toISOString(), created_at: row.created_at.toISOString(),
      },
    };
  });

  app.post<{ Params: { id: string } }>(
    '/demo-sessions/:id/admin-launch',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request, reply) => {
    assertId(request.params.id);
    const row = await loadSession(db, request.params.id);
    if (!row) throw errors.notFound();
    requireSessionOwner(request, row);
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
    },
  );

  app.post<{ Params: { id: string } }>(
    '/demo-sessions/:id/reset',
    // A reset respawns a runtime server — it costs like a create, so it
    // is throttled like one, plus the per-session cooldown below.
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request) => {
    assertId(request.params.id);
    const row = await loadSession(db, request.params.id);
    if (!row) throw errors.notFound();
    requireSessionOwner(request, row);
    if (row.status !== 'active') throw errors.conflict('demo.not_active');
    if (row.last_reset_at && Date.now() - row.last_reset_at.getTime() < RESET_COOLDOWN_MS) throw errors.tooMany(30);
    await db.query('UPDATE demo_sessions SET last_reset_at = now() WHERE id = $1', [row.id]);
    const pidRow = await db.query<{ runtime_pid: number | null }>('SELECT runtime_pid FROM demo_sessions WHERE id = $1', [row.id]);
    if (row.runtime_port || pidRow.rows[0]?.runtime_pid) {
      // Respawn via the worker: blank the port first so the wait below
      // only completes on the NEW server, and hand the worker the old pid
      // to stop (expect_pid).
      await db.query(
        'UPDATE demo_sessions SET runtime_port = NULL, admin_token_hash = NULL, admin_token_expires_at = NULL, demo_admin_ready = false WHERE id = $1',
        [row.id],
      );
      await enqueueDemoSpawn(db, row.id, pidRow.rows[0]?.runtime_pid ?? null);
      await waitForDemoRuntime(db, config, row.id);
    } else {
      await db.query('UPDATE demo_sessions SET admin_token_hash = NULL, admin_token_expires_at = NULL, demo_admin_ready = false WHERE id = $1', [row.id]);
    }
    const fresh = await loadSession(db, row.id);
    return { data: { id: row.id, url: sessionUrl(config, fresh!), status: fresh!.status, expires_at: fresh!.expires_at.toISOString() } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/demo-sessions/:id/cancel',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (request) => {
    assertId(request.params.id);
    const row = await db.query<{ runtime_pid: number | null; preview_label: string | null; owner_token_hash: Buffer | null }>('SELECT runtime_pid, preview_label, owner_token_hash FROM demo_sessions WHERE id = $1', [request.params.id]);
    if (!row.rows[0]) throw errors.notFound();
    requireSessionOwner(request, row.rows[0]!);
    await db.query("UPDATE demo_sessions SET status = 'cancelled' WHERE id = $1", [request.params.id]);
    await enqueueDemoStop(db, request.params.id, row.rows[0]!.runtime_pid);
    await writeAudit(db, { actorType: 'user', actorId: null, action: 'demo.cancelled', resourceType: 'demo_session', resourceId: request.params.id, traceId: request.id });
    return { data: { id: request.params.id, status: 'cancelled' } };
    },
  );
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
    await db.query("UPDATE demo_sessions SET status = 'expired' WHERE id = $1", [request.params.id]);
    await enqueueDemoStop(db, request.params.id, row.rows[0]!.runtime_pid);
    return { data: { id: request.params.id, status: 'expired' } };
  });
}
