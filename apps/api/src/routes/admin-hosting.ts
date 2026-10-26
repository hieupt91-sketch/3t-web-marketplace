import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { enqueueJob, isUniqueViolation } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { killPid } from '../lib/process.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

/**
 * A15–A19 admin hosting operations.
 * Admin actions go through the same allowlist as customer actions: restart,
 * suspend, resume — each with a written reason. There is no arbitrary terminal
 * in the web UI (A15). Suspend stops the runtime process; resume re-spawns it
 * from the site directory via a restart job.
 */
export async function adminHostingRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get<{ Querystring: { status?: string } }>('/sites', async (request) => {
    requirePermission(request, 'site:operate');
    const params: unknown[] = [];
    let where = '';
    if (request.query.status) {
      params.push(request.query.status);
      where = `WHERE s.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT s.*, sub.current_period_end AS subscription_end, sub.status AS subscription_status
       FROM sites s LEFT JOIN subscriptions sub ON sub.site_id = s.id AND sub.status IN ('active', 'grace')
       ${where} ORDER BY s.created_at DESC LIMIT 100`,
      params,
    );
    return { data: rows };
  });

  app.get<{ Params: { id: string } }>('/sites/:id', async (request) => {
    requirePermission(request, 'site:operate');
    assertId(request.params.id);
    const site = await db.query('SELECT * FROM sites WHERE id = $1', [request.params.id]);
    if (!site.rows[0]) throw errors.notFound();
    const [deployments, domains, subscription, members] = await Promise.all([
      db.query('SELECT * FROM deployments WHERE site_id = $1 ORDER BY created_at DESC LIMIT 20', [request.params.id]),
      db.query('SELECT * FROM domains WHERE site_id = $1 ORDER BY created_at DESC', [request.params.id]),
      db.query('SELECT * FROM subscriptions WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1', [request.params.id]),
      db.query('SELECT m.user_id, m.role, u.email_normalized AS email FROM site_members m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1', [request.params.id]),
    ]);
    return { data: { ...site.rows[0], deployments: deployments.rows, domains: domains.rows, subscription: subscription.rows[0] ?? null, members: members.rows } };
  });

  app.post<{ Params: { id: string }; Body: { action: 'restart' | 'suspend' | 'resume'; reason: string } }>(
    '/sites/:id/operations',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['action', 'reason'], properties: { action: { enum: ['restart', 'suspend', 'resume'] }, reason: { type: 'string', minLength: 3, maxLength: 500 } } } } },
    async (request) => {
      const auth = requirePermission(request, 'site:operate');
      assertId(request.params.id);
      const site = await db.query<{ status: string; runtime_pid: number | null; owner_id: string }>('SELECT status, runtime_pid, owner_id FROM sites WHERE id = $1', [request.params.id]);
      if (!site.rows[0]) throw errors.notFound();
      const row = site.rows[0]!;
      if (request.body.action === 'suspend') {
        if (row.status !== 'active') throw errors.conflict('site.not_active');
        killPid(row.runtime_pid);
        await db.query("UPDATE sites SET status = 'suspended', runtime_port = NULL, runtime_pid = NULL WHERE id = $1", [request.params.id]);
      } else if (request.body.action === 'resume') {
        if (row.status !== 'suspended') throw errors.conflict('site.not_suspended');
        const { job } = await enqueueJob(db, { type: 'site.restart', dedupeKey: `site.restart:${request.params.id}:${Date.now()}:${randomBytes(4).toString('hex')}`, payload: { site_id: request.params.id }, resourceType: 'site', resourceId: request.params.id, ownerId: row.owner_id });
        return { data: { action: 'resume', job_id: job.id } };
      } else {
        if (row.status !== 'active' && row.status !== 'suspended') throw errors.conflict('site.not_active');
        const { job } = await enqueueJob(db, { type: 'site.restart', dedupeKey: `site.restart:${request.params.id}:${Date.now()}:${randomBytes(4).toString('hex')}`, payload: { site_id: request.params.id }, resourceType: 'site', resourceId: request.params.id, ownerId: row.owner_id });
        return { data: { action: 'restart', job_id: job.id } };
      }
      return { data: { action: request.body.action } };
    },
  );

  app.get<{ Querystring: { status?: string } }>('/domains', async (request) => {
    requirePermission(request, 'site:operate');
    const params: unknown[] = [];
    let where = '';
    if (request.query.status) {
      params.push(request.query.status);
      where = `WHERE d.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT d.*, s.display_name AS site_name, s.owner_id FROM domains d JOIN sites s ON s.id = d.site_id ${where} ORDER BY d.created_at DESC LIMIT 100`,
      params,
    );
    return { data: rows };
  });

  app.get<{ Querystring: { site_id?: string; status?: string } }>('/backups', async (request) => {
    requirePermission(request, 'site:operate');
    const params: unknown[] = [];
    const where: string[] = [];
    if (request.query.site_id) {
      assertId(request.query.site_id);
      params.push(request.query.site_id);
      where.push(`b.site_id = $${params.length}`);
    }
    if (request.query.status) {
      params.push(request.query.status);
      where.push(`b.status = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT b.*, s.display_name AS site_name FROM backups b JOIN sites s ON s.id = b.site_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.created_at DESC LIMIT 100`,
      params,
    );
    return { data: rows };
  });

  // A18 — job queue oversight. A running job with a valid lease is never retried (A18).
  app.get<{ Querystring: { status?: string } }>('/jobs', async (request) => {
    requirePermission(request, 'ops:read');
    const params: unknown[] = [];
    let where = '';
    if (request.query.status) {
      params.push(request.query.status);
      where = `WHERE status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT id, type, status, attempts, max_attempts, step, last_error_code, lease_until, next_run_at, created_at, finished_at FROM jobs ${where} ORDER BY created_at DESC LIMIT 100`,
      params,
    );
    return { data: rows };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/retry', async (request) => {
    requirePermission(request, 'ops:execute');
    assertId(request.params.id);
    const job = await db.query<{ status: string; lease_until: Date | null }>('SELECT status, lease_until FROM jobs WHERE id = $1', [request.params.id]);
    if (!job.rows[0]) throw errors.notFound();
    if (job.rows[0]!.status === 'running' && job.rows[0]!.lease_until && new Date(job.rows[0]!.lease_until) > new Date()) throw errors.conflict('jobs.lease_active');
    if (job.rows[0]!.status === 'succeeded') throw errors.conflict('jobs.already_succeeded');
    await db.query("UPDATE jobs SET status = 'queued', next_run_at = now(), lease_until = NULL, lease_owner = NULL WHERE id = $1", [request.params.id]);
    return { data: { status: 'queued' } };
  });

  // Renewal application (AT-28): a paid renewal order extends the period exactly
  // once — the order_item_id primary key makes a duplicate apply a 409.
  app.post<{ Params: { id: string }; Body: { order_item_id: string } }>(
    '/subscriptions/:id/apply-renewal',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['order_item_id'], properties: { order_item_id: { type: 'string' } } } } },
    async (request) => {
      requirePermission(request, 'payment:confirm');
      assertId(request.params.id);
      assertId(request.body.order_item_id);
      const sub = await db.query<{ site_id: string; status: string; current_period_end: Date; policy_snapshot: { period_days?: number } }>(
        'SELECT site_id, status, current_period_end, policy_snapshot FROM subscriptions WHERE id = $1',
        [request.params.id],
      );
      if (!sub.rows[0]) throw errors.notFound();
      const item = await db.query<{ order_status: string }>(
        `SELECT o.status AS order_status FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = $1`,
        [request.body.order_item_id],
      );
      if (!item.rows[0] || item.rows[0]!.order_status !== 'paid') throw errors.validation([{ field: 'order_item_id', code: 'not_paid' }]);
      const periodDays = sub.rows[0]!.policy_snapshot.period_days ?? 365;
      const start = new Date(Math.max(new Date(sub.rows[0]!.current_period_end).getTime(), Date.now()));
      const end = new Date(start.getTime() + periodDays * 24 * 3600_000);
      try {
        await db.query(
          'INSERT INTO renewal_applications (order_item_id, subscription_id, period_start, period_end) VALUES ($1, $2, $3, $4)',
          [request.body.order_item_id, request.params.id, start.toISOString(), end.toISOString()],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict('renewal.already_applied');
        throw error;
      }
      await db.query(
        "UPDATE subscriptions SET current_period_start = $2, current_period_end = $3, status = 'active' WHERE id = $1",
        [request.params.id, start.toISOString(), end.toISOString()],
      );
      await db.query("UPDATE sites SET status = 'active' WHERE id = $1 AND status IN ('grace', 'suspended')", [sub.rows[0]!.site_id]);
      return { data: { period_start: start.toISOString(), period_end: end.toISOString() } };
    },
  );

  // Renewal/grace/suspend/purge lifecycle sweep (AT-29), driven by policy_snapshot.
  app.post('/sites/lifecycle-sweep', async (request) => {
    requirePermission(request, 'ops:execute');
    const now = new Date();
    const toGrace = await db.query(
      `UPDATE subscriptions SET status = 'grace' WHERE status = 'active' AND current_period_end < now() RETURNING site_id`,
    );
    for (const row of toGrace.rows) {
      await db.query("UPDATE sites SET status = 'grace' WHERE id = $1 AND status = 'active'", [row.site_id]);
    }
    const subs = await db.query<{ id: string; site_id: string; current_period_end: Date; policy_snapshot: { grace_days?: number } }>(
      "SELECT id, site_id, current_period_end, policy_snapshot FROM subscriptions WHERE status = 'grace'",
    );
    let suspended = 0;
    for (const sub of subs.rows) {
      const graceEnd = new Date(sub.current_period_end).getTime() + (sub.policy_snapshot.grace_days ?? 7) * 24 * 3600_000;
      if (graceEnd < now.getTime()) {
        await db.query("UPDATE subscriptions SET status = 'suspended' WHERE id = $1", [sub.id]);
        const site = await db.query<{ runtime_pid: number | null }>('SELECT runtime_pid FROM sites WHERE id = $1', [sub.site_id]);
        if (site.rows[0]) killPid(site.rows[0]!.runtime_pid);
        await db.query("UPDATE sites SET status = 'suspended', runtime_port = NULL, runtime_pid = NULL WHERE id = $1", [sub.site_id]);
        suspended += 1;
      }
    }
    const purgeable = await db.query<{ id: string; runtime_pid: number | null }>(
      "SELECT id, runtime_pid FROM sites WHERE status = 'delete_scheduled' AND purge_at < now()",
    );
    let purged = 0;
    for (const site of purgeable.rows) {
      killPid(site.runtime_pid);
      await rm(join(config.workDir, 'sites', site.id), { recursive: true, force: true });
      await db.query("UPDATE sites SET status = 'purged', subdomain = NULL, purge_at = NULL WHERE id = $1", [site.id]);
      purged += 1;
    }
    return { data: { to_grace: toGrace.rowCount ?? 0, suspended, purged } };
  });
}
