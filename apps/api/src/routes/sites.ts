import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { lookup, resolveTxt } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { enqueueJob, isUniqueViolation, tx, validateDynamicContent, writeAudit } from '@3t/core';
import { requireUser } from '../app.ts';
import { requireStepUp } from '../lib/step-up.ts';
import { errors } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const RESERVED = new Set(['admin', 'api', 'app', 'www', 'support', 'billing', 'static', 'preview', 'demo', 'mail', 'ftp', 'ns1', 'ns2', 'portal', 'account', 'auth', 'login', 'checkout', 'cdn', 'assets', 'root', 'system']);

interface SiteView {
  id: string;
  owner_id: string;
  entitlement_id: string | null;
  template_version_id: string;
  display_name: string;
  subdomain: string | null;
  default_locale: string;
  status: string;
  previous_status: string | null;
  demo_session_id: string | null;
  runtime_kind: string | null;
  runtime_port: number | null;
  runtime_pid: number | null;
  [key: string]: unknown;
}

function siteUrl(row: { runtime_port: number | null; subdomain: string | null }, originTemplate: string): string | null {
  // Public URL via the site router once the site has its subdomain; the
  // loopback runtime URL remains only as an internal fallback.
  if (row.subdomain) return `${originTemplate.replace('{label}', row.subdomain)}/`;
  if (row.runtime_port) return `http://127.0.0.1:${row.runtime_port}/`;
  return null;
}

/** Owner, or a member with read access; otherwise 404 (no existence leak, AT-24). */
async function loadSiteForUser(db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> }, siteId: string, userId: string, ownerOnly = false): Promise<SiteView> {
  assertId(siteId);
  const { rows } = await db.query<SiteView>(
    `SELECT s.*, EXISTS (SELECT 1 FROM site_members m WHERE m.site_id = s.id AND m.user_id = $2 AND m.role = 'owner') AS is_owner
     FROM sites s WHERE s.id = $1 AND (s.owner_id = $2 OR EXISTS (SELECT 1 FROM site_members m WHERE m.site_id = s.id AND m.user_id = $2))`,
    [siteId, userId],
  );
  const row = rows[0];
  if (!row) throw errors.notFound();
  if (ownerOnly && row.owner_id !== userId) throw errors.notFound();
  return row;
}

async function enqueueSiteJob(db: Parameters<typeof enqueueJob>[0], type: string, siteId: string, payload: Record<string, unknown>, ownerId: string) {
  const { job } = await enqueueJob(db, {
    type,
    dedupeKey: `${type}:${siteId}:${Date.now()}:${randomBytes(4).toString('hex')}`,
    payload: { site_id: siteId, ...payload },
    resourceType: 'site',
    resourceId: siteId,
    ownerId,
  });
  return job;
}

/**
 * M5 hosting (docs/02 §5, docs/05 C05–C12/C15).
 * Tenant isolation (AT-24): every route re-checks owner/member on the site row;
 * a site server only ever serves its own directory. Domain re-attach (AT-27)
 * always mints a fresh verification token. A provision failure (AT-23) keeps
 * the site and the entitlement: the owner retries the same site id.
 */
export async function siteRoutes(app: FastifyInstance): Promise<void> {
  const { db, store, config } = app.deps;

  // ---- Subdomain reservations (docs/12 DEP-06) ----
  // A hold is a short-lived, non-binding claim on a name while the owner
  // finishes deploying. It never charges the subdomain fee (the fee stays
  // an owner-set admin value confirmed at handover) and it never creates
  // a site. Expiry is lazy on every read path; the worker sweeps rows in
  // bulk. The TTL comes from the 'subdomain.reservation' platform setting
  // (migration 0025 seeds 15 minutes; owner-tunable in admin settings).
  interface HoldRow { id: string; user_id: string; expires_at: Date }

  async function reservationTtlMinutes(): Promise<number> {
    const { rows } = await db.query<{ value_json: { ttl_minutes?: number } }>(
      "SELECT value_json FROM settings WHERE key = 'subdomain.reservation'",
    );
    const ttl = rows[0]?.value_json?.ttl_minutes;
    return Number.isInteger(ttl) && ttl! >= 1 && ttl! <= 1440 ? ttl! : 15;
  }

  /** The active hold for a name, lazily expiring it when its TTL has passed. */
  async function currentHold(client: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> }, subdomain: string): Promise<HoldRow | null> {
    const { rows } = await client.query<HoldRow>(
      "SELECT id, user_id, expires_at FROM subdomain_reservations WHERE subdomain = $1 AND status = 'active'",
      [subdomain],
    );
    const hold = rows[0];
    if (!hold) return null;
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      await client.query("UPDATE subdomain_reservations SET status = 'expired' WHERE id = $1 AND status = 'active'", [hold.id]);
      return null;
    }
    return hold;
  }

  app.post<{ Body: { entitlement_id: string; display_name: string; subdomain: string; default_locale?: 'vi' | 'en'; demo_session_id?: string } }>(
    '/sites',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['entitlement_id', 'display_name', 'subdomain'], properties: { entitlement_id: { type: 'string' }, display_name: { type: 'string', minLength: 1, maxLength: 120 }, subdomain: { type: 'string', minLength: 3, maxLength: 40 }, default_locale: { enum: ['vi', 'en'] }, demo_session_id: { type: 'string' } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = request.body;
      assertId(body.entitlement_id);
      if (body.demo_session_id) assertId(body.demo_session_id);
      if (!SUBDOMAIN_RE.test(body.subdomain) || RESERVED.has(body.subdomain)) throw errors.validation([{ field: 'subdomain', code: 'invalid' }]);
      const created = await tx(db, async (client) => {
        // Lock the entitlement row: two concurrent creates for one slot cannot
        // both pass the quota check (AT-22).
        const ent = await client.query<{ id: string; user_id: string; template_id: string; version_id: string; mode: string; status: string; instance_limit: number }>(
          'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
          [body.entitlement_id],
        );
        const e = ent.rows[0];
        if (!e || e.user_id !== auth.userId) throw errors.notFound();
        if (e.mode !== 'hosted' || e.status !== 'active') throw errors.conflict('site.entitlement_not_hosted');
        const used = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM sites WHERE entitlement_id = $1 AND status NOT IN ('purged')",
          [body.entitlement_id],
        );
        if (Number(used.rows[0]!.n) >= e.instance_limit) throw errors.conflict('site.quota_exceeded');
        let demoSessionId: string | null = null;
        if (body.demo_session_id) {
          const demo = await client.query<{ version_id: string; status: string }>('SELECT version_id, status FROM demo_sessions WHERE id = $1', [body.demo_session_id]);
          if (!demo.rows[0] || demo.rows[0]!.status !== 'active' || demo.rows[0]!.version_id !== e.version_id) throw errors.conflict('site.demo_mismatch');
          demoSessionId = body.demo_session_id;
        }
        // DEP-06: a live hold by another customer blocks the create even
        // when both customers passed the availability check earlier
        // (UX-12); the creator's own hold is consumed below.
        const hold = await currentHold(client, body.subdomain);
        if (hold && hold.user_id !== auth.userId) throw errors.conflict('site.subdomain_held');
        let site;
        try {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, default_locale, demo_session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [auth.userId, body.entitlement_id, e.version_id, body.display_name, body.subdomain, body.default_locale ?? 'vi', demoSessionId],
          );
          site = inserted.rows[0]!;
        } catch (error) {
          if (isUniqueViolation(error)) throw errors.conflict('site.subdomain_taken');
          throw error;
        }
        await client.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [site.id, auth.userId]);
        if (hold) await client.query("UPDATE subdomain_reservations SET status = 'consumed' WHERE id = $1 AND status = 'active'", [hold.id]);
        const job = await enqueueSiteJob(client, 'site.provision', site.id, {}, auth.userId);
        const dep = await client.query<{ id: string }>(
          "INSERT INTO deployments (site_id, version_id, artifact_id, operation, status, job_id) SELECT $1, $2, artifact_id, 'provision', 'pending', $3 FROM template_versions WHERE id = $2 RETURNING id",
          [site.id, e.version_id, job.id],
        );
        await client.query("UPDATE jobs SET payload_json = payload_json || $2::jsonb WHERE id = $1", [job.id, JSON.stringify({ deployment_id: dep.rows[0]!.id })]);
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'site.created', resourceType: 'site', resourceId: site.id, traceId: request.id, diff: { subdomain: body.subdomain } });
        return { siteId: site.id, jobId: job.id, deploymentId: dep.rows[0]!.id };
      });
      return reply.status(201).send({ data: { id: created.siteId, status: 'creating', job_id: created.jobId, deployment_id: created.deploymentId, progress_url: `/api/v1/jobs/${created.jobId}` } });
    },
  );

  /**
   * Subdomain availability for the post-purchase setup wizard: checks the
   * platform's own subdomain registry (the sites table) plus the reserved
   * list. It does NOT reserve or sell the name — assignment and the
   * subdomain fee are owner steps at handover.
   */
  app.get<{ Querystring: { subdomain?: string } }>('/sites/check-subdomain', async (request) => {
    const auth = requireUser(request);
    const raw = (request.query.subdomain ?? '').toLowerCase();
    if (!SUBDOMAIN_RE.test(raw)) return { data: { subdomain: raw, available: false, reason: 'invalid' } };
    if (RESERVED.has(raw)) return { data: { subdomain: raw, available: false, reason: 'reserved' } };
    const { rows } = await db.query('SELECT 1 FROM sites WHERE subdomain = $1 LIMIT 1', [raw]);
    if (rows.length > 0) return { data: { subdomain: raw, available: false, reason: 'taken' } };
    // DEP-06: an unexpired hold by another customer also makes the name
    // unavailable; the holder sees their own hold as available.
    const hold = await currentHold(db, raw);
    if (hold) {
      if (hold.user_id === auth.userId) {
        return { data: { subdomain: raw, available: true, reason: null, held_by_you: true, reservation_expires_at: new Date(hold.expires_at).toISOString() } };
      }
      return { data: { subdomain: raw, available: false, reason: 'held', held_by_you: false, reservation_expires_at: new Date(hold.expires_at).toISOString() } };
    }
    return { data: { subdomain: raw, available: true, reason: null } };
  });

  app.get('/sites/subdomain-reservations', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ subdomain: string; entitlement_id: string | null; expires_at: Date; created_at: Date }>(
      "SELECT subdomain, entitlement_id, expires_at, created_at FROM subdomain_reservations WHERE user_id = $1 AND status = 'active' AND expires_at > now() ORDER BY expires_at",
      [auth.userId],
    );
    return { data: rows.map((r) => ({ subdomain: r.subdomain, entitlement_id: r.entitlement_id, expires_at: r.expires_at.toISOString(), created_at: r.created_at.toISOString() })) };
  });

  app.post<{ Body: { subdomain: string; entitlement_id?: string } }>(
    '/sites/subdomain-reservations',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['subdomain'], properties: { subdomain: { type: 'string', minLength: 3, maxLength: 40 }, entitlement_id: { type: 'string' } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const subdomain = request.body.subdomain.toLowerCase();
      if (!SUBDOMAIN_RE.test(subdomain)) throw errors.validation([{ field: 'subdomain', code: 'invalid' }]);
      if (RESERVED.has(subdomain)) throw errors.validation([{ field: 'subdomain', code: 'reserved' }]);
      if (request.body.entitlement_id) assertId(request.body.entitlement_id);
      const ttl = await reservationTtlMinutes();
      const result = await tx(db, async (client) => {
        if (request.body.entitlement_id) {
          const ent = await client.query<{ user_id: string; mode: string; status: string }>(
            'SELECT user_id, mode, status FROM entitlements WHERE id = $1',
            [request.body.entitlement_id],
          );
          const e = ent.rows[0];
          if (!e || e.user_id !== auth.userId || e.mode !== 'hosted' || e.status !== 'active') throw errors.notFound();
        }
        const taken = await client.query('SELECT 1 FROM sites WHERE subdomain = $1 LIMIT 1', [subdomain]);
        if (taken.rows.length > 0) throw errors.conflict('site.subdomain_taken');
        const hold = await currentHold(client, subdomain);
        if (hold && hold.user_id !== auth.userId) throw errors.conflict('site.subdomain_held');
        if (hold) {
          // Renewing your own hold extends it from now.
          const { rows } = await client.query<{ expires_at: Date }>(
            "UPDATE subdomain_reservations SET expires_at = now() + make_interval(mins => $2), entitlement_id = COALESCE($3, entitlement_id) WHERE id = $1 RETURNING expires_at",
            [hold.id, ttl, request.body.entitlement_id ?? null],
          );
          return { status: 200, expires_at: rows[0]!.expires_at };
        }
        try {
          const { rows } = await client.query<{ expires_at: Date }>(
            "INSERT INTO subdomain_reservations (subdomain, user_id, entitlement_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at",
            [subdomain, auth.userId, request.body.entitlement_id ?? null, ttl],
          );
          return { status: 201, expires_at: rows[0]!.expires_at };
        } catch (error) {
          // Lost the race against the partial unique index.
          if (isUniqueViolation(error)) throw errors.conflict('site.subdomain_held');
          throw error;
        }
      });
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'site.subdomain_reserved', resourceType: 'site', resourceId: null, traceId: request.id, diff: { subdomain, ttl_minutes: ttl } });
      return reply.status(result.status).send({ data: { subdomain, expires_at: new Date(result.expires_at).toISOString(), ttl_minutes: ttl } });
    },
  );

  app.delete<{ Params: { subdomain: string } }>('/sites/subdomain-reservations/:subdomain', async (request, reply) => {
    const auth = requireUser(request);
    await db.query(
      "UPDATE subdomain_reservations SET status = 'released' WHERE subdomain = $1 AND user_id = $2 AND status = 'active'",
      [request.params.subdomain.toLowerCase(), auth.userId],
    );
    return reply.status(204).send();
  });

  /**
   * Connection check for the "our subdomain + customer's own VPS" case:
   * resolves the hostname from the server (never trusts the browser's
   * view), refuses IP literals and private/reserved targets, then fetches
   * the HTTPS URL with a short timeout and reports only the status. The
   * body is never read or returned. DNS failures are reported as data,
   * not errors, because "not propagated yet" is the normal state right
   * after setup.
   */
  app.get<{ Querystring: { hostname?: string } }>('/sites/connection-check', async (request) => {
    requireUser(request);
    const hostname = (request.query.hostname ?? '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,61}(\.[a-z0-9][a-z0-9-]{0,61})+$/.test(hostname) || hostname.length > 253 || isIP(hostname)) {
      throw errors.validation([{ field: 'hostname', code: 'invalid' }]);
    }
    let addresses: string[] = [];
    try {
      addresses = (await lookup(hostname, { all: true })).map((a) => a.address);
    } catch {
      return { data: { hostname, dns_ok: false, addresses: 0, private: false, http_ok: false, http_status: null }, meta: { request_id: request.id } };
    }
    const isPrivate = (ip: string): boolean => {
      if (ip.includes(':')) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
      const [a, b] = ip.split('.').map(Number);
      return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
    };
    if (addresses.length === 0 || addresses.some(isPrivate)) {
      return { data: { hostname, dns_ok: addresses.length > 0, addresses: addresses.length, private: true, http_ok: false, http_status: null }, meta: { request_id: request.id } };
    }
    let http_status: number | null = null;
    try {
      const res = await fetch(`https://${hostname}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
      http_status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      http_status = null;
    }
    return { data: { hostname, dns_ok: true, addresses: addresses.length, private: false, http_ok: http_status !== null, http_status }, meta: { request_id: request.id } };
  });

  app.get('/sites', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query(
      `SELECT s.*, sub.current_period_end AS subscription_end, sub.status AS subscription_status
       FROM sites s LEFT JOIN subscriptions sub ON sub.site_id = s.id AND sub.status IN ('active', 'grace')
       WHERE s.owner_id = $1 OR EXISTS (SELECT 1 FROM site_members m WHERE m.site_id = s.id AND m.user_id = $1)
       ORDER BY s.created_at DESC LIMIT 100`,
      [auth.userId],
    );
    return { data: rows.map((r) => ({ ...r, url: siteUrl(r, config.siteOriginTemplate) })) };
  });

  app.get<{ Params: { id: string } }>('/sites/:id', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId);
    const [deployments, domains, subscription, template] = await Promise.all([
      db.query('SELECT * FROM deployments WHERE site_id = $1 ORDER BY created_at DESC LIMIT 20', [site.id]),
      db.query('SELECT id, hostname_ascii, status, is_primary, verified_at, cert_expires_at, created_at FROM domains WHERE site_id = $1 ORDER BY created_at DESC', [site.id]),
      db.query('SELECT * FROM subscriptions WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1', [site.id]),
      db.query<{ template_id: string; manifest_json: { capabilities?: string[] } }>('SELECT template_id, manifest_json FROM template_versions WHERE id = $1', [site.template_version_id]),
    ]);
    return { data: { ...site, url: siteUrl(site, config.siteOriginTemplate), template_id: template.rows[0]?.template_id ?? null, capabilities: template.rows[0]?.manifest_json?.capabilities ?? [], deployments: deployments.rows, domains: domains.rows, subscription: subscription.rows[0] ?? null } };
  });

  app.get<{ Params: { id: string } }>('/sites/:id/deployments', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId);
    const { rows } = await db.query('SELECT * FROM deployments WHERE site_id = $1 ORDER BY created_at DESC LIMIT 50', [site.id]);
    return { data: rows };
  });

  app.post<{ Params: { id: string } }>('/sites/:id/retry', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status !== 'provision_failed') throw errors.conflict('site.not_failed');
    const job = await enqueueSiteJob(db, 'site.provision', site.id, {}, auth.userId);
    const dep = await db.query<{ id: string }>("INSERT INTO deployments (site_id, version_id, artifact_id, operation, status, job_id) SELECT $1, $2, artifact_id, 'provision', 'pending', $3 FROM template_versions WHERE id = $2 RETURNING id", [site.id, site.template_version_id, job.id]);
    await db.query("UPDATE jobs SET payload_json = payload_json || $2::jsonb WHERE id = $1", [job.id, JSON.stringify({ deployment_id: dep.rows[0]!.id })]);
    await db.query("UPDATE sites SET status = 'creating' WHERE id = $1", [site.id]);
    return { data: { id: site.id, status: 'creating', job_id: job.id } };
  });

  app.post<{ Params: { id: string } }>('/sites/:id/restart', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status !== 'active') throw errors.conflict('site.not_active');
    const job = await enqueueSiteJob(db, 'site.restart', site.id, {}, auth.userId);
    return { data: { job_id: job.id } };
  });

  app.post<{ Params: { id: string }; Body: { version_id: string } }>(
    '/sites/:id/update',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['version_id'], properties: { version_id: { type: 'string' } } } } },
    async (request) => {
      const auth = requireUser(request);
      const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
      if (site.status !== 'active') throw errors.conflict('site.not_active');
      assertId(request.body.version_id);
      const version = await db.query<{ template_id: string; artifact_id: string }>('SELECT template_id, artifact_id FROM template_versions WHERE id = $1', [request.body.version_id]);
      const template = await db.query<{ template_id: string }>('SELECT template_id FROM template_versions WHERE id = $1', [site.template_version_id]);
      if (!version.rows[0] || version.rows[0]!.template_id !== template.rows[0]!.template_id) throw errors.validation([{ field: 'version_id', code: 'not_found' }]);
      const dep = await db.query<{ id: string }>(
        "INSERT INTO deployments (site_id, version_id, artifact_id, operation, status) VALUES ($1, $2, $3, 'update', 'pending') RETURNING id",
        [site.id, request.body.version_id, version.rows[0]!.artifact_id],
      );
      const job = await enqueueSiteJob(db, 'site.update', site.id, { version_id: request.body.version_id, deployment_id: dep.rows[0]!.id }, auth.userId);
      await db.query('UPDATE deployments SET job_id = $2 WHERE id = $1', [dep.rows[0]!.id, job.id]);
      return { data: { deployment_id: dep.rows[0]!.id, job_id: job.id } };
    },
  );

  // ---- Domains (C08) ----
  app.post<{ Params: { id: string }; Body: { hostname: string } }>(
    '/sites/:id/domains',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['hostname'], properties: { hostname: { type: 'string', minLength: 1, maxLength: 253 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
      let ascii = domainToASCII(request.body.hostname.trim().toLowerCase());
      if (!ascii || ascii.includes('/') || ascii.includes(':') || isIP(ascii) !== 0 || !ascii.includes('.')) throw errors.validation([{ field: 'hostname', code: 'invalid' }]);
      if (ascii.endsWith(`.${config.previewBaseDomain}`) || ascii === config.previewBaseDomain) throw errors.validation([{ field: 'hostname', code: 'platform_domain' }]);
      const token = randomBytes(32).toString('hex');
      try {
        const { rows } = await db.query<{ id: string }>(
          'INSERT INTO domains (site_id, hostname_ascii, verification_token_hash) VALUES ($1, $2, $3) RETURNING id',
          [site.id, ascii, createHash('sha256').update(token).digest('hex')],
        );
        return reply.status(201).send({ data: { id: rows[0]!.id, hostname_ascii: ascii, status: 'pending', verification_token: token, txt_name: `_3t-verify.${ascii}`, txt_value: token } });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict('domain.taken');
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string; domainId: string }; Body: { txt_value?: string } }>(
    '/sites/:id/domains/:domainId/verify',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { txt_value: { type: 'string' } } } } },
    async (request) => {
      const auth = requireUser(request);
      const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
      assertId(request.params.domainId);
      const domain = await db.query<{ hostname_ascii: string; status: string; verification_token_hash: string; last_verify_at: Date | null }>(
        'SELECT hostname_ascii, status, verification_token_hash, last_verify_at FROM domains WHERE id = $1 AND site_id = $2',
        [request.params.domainId, site.id],
      );
      if (!domain.rows[0]) throw errors.notFound();
      if (domain.rows[0]!.status === 'verified') return { data: { status: 'verified' } };
      if (domain.rows[0]!.last_verify_at && Date.now() - new Date(domain.rows[0]!.last_verify_at).getTime() < 60_000) throw errors.conflict('domain.verify_cooldown');
      await db.query('UPDATE domains SET last_verify_at = now() WHERE id = $1', [request.params.domainId]);
      let ok = false;
      // Dev/test proof: presenting the token proves control (stand-in for a DNS read).
      if (config.dnsVerifyBodyProof && request.body.txt_value) {
        ok = createHash('sha256').update(request.body.txt_value).digest('hex') === domain.rows[0]!.verification_token_hash;
      } else {
        // Production path: read the TXT record. A failed lookup keeps the domain pending (AT-25/AT-26).
        try {
          const records = await resolveTxt(`_3t-verify.${domain.rows[0]!.hostname_ascii}`);
          ok = records.flat().some((value) => createHash('sha256').update(value).digest('hex') === domain.rows[0]!.verification_token_hash);
        } catch {
          ok = false;
        }
      }
      if (!ok) return { data: { status: 'pending', verified: false } };
      await db.query("UPDATE domains SET status = 'verified', verified_at = now(), cert_expires_at = now() + interval '90 days' WHERE id = $1", [request.params.domainId]);
      return { data: { status: 'verified', verified: true } };
    },
  );

  app.post<{ Params: { id: string; domainId: string } }>('/sites/:id/domains/:domainId/make-primary', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    assertId(request.params.domainId);
    const domain = await db.query<{ status: string }>('SELECT status FROM domains WHERE id = $1 AND site_id = $2', [request.params.domainId, site.id]);
    if (!domain.rows[0]) throw errors.notFound();
    if (domain.rows[0]!.status !== 'verified') throw errors.conflict('domain.not_verified');
    await tx(db, async (client) => {
      await client.query('UPDATE domains SET is_primary = false WHERE site_id = $1', [site.id]);
      await client.query('UPDATE domains SET is_primary = true WHERE id = $1', [request.params.domainId]);
    });
    return { data: { status: 'primary' } };
  });

  app.post<{ Params: { id: string; domainId: string } }>('/sites/:id/domains/:domainId/release', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    assertId(request.params.domainId);
    const domain = await db.query('SELECT 1 FROM domains WHERE id = $1 AND site_id = $2', [request.params.domainId, site.id]);
    if (!domain.rows[0]) throw errors.notFound();
    await db.query("UPDATE domains SET status = 'released', is_primary = false WHERE id = $1", [request.params.domainId]);
    return { data: { status: 'released' } };
  });

  // ---- Backups, exports, data (C10/C15) ----
  async function createBackup(siteId: string, ownerId: string, kind: 'backup' | 'export') {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO backups (site_id, kind, expires_at) VALUES ($1, $2, now() + interval '30 days') RETURNING id",
      [siteId, kind],
    );
    const job = await enqueueSiteJob(db, 'site.backup', siteId, { backup_id: rows[0]!.id }, ownerId);
    return { backupId: rows[0]!.id, jobId: job.id };
  }

  app.post<{ Params: { id: string } }>('/sites/:id/backups', async (request, reply) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status !== 'active' && site.status !== 'suspended') throw errors.conflict('site.not_backed_up');
    const created = await createBackup(site.id, auth.userId, 'backup');
    return reply.status(202).send({ data: created });
  });

  app.get<{ Params: { id: string } }>('/sites/:id/backups', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    const { rows } = await db.query("SELECT id, kind, status, checksum, created_at, expires_at FROM backups WHERE site_id = $1 AND kind IN ('backup', 'export') ORDER BY created_at DESC LIMIT 50", [site.id]);
    return { data: rows };
  });

  app.post<{ Params: { id: string; backupId: string }; Body: { confirm_name: string } }>(
    '/sites/:id/backups/:backupId/restore',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['confirm_name'], properties: { confirm_name: { type: 'string' } } } } },
    async (request) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
      if (request.body.confirm_name !== site.display_name) throw errors.validation([{ field: 'confirm_name', code: 'mismatch' }]);
      assertId(request.params.backupId);
      const backup = await db.query<{ status: string; artifact_id: string | null }>('SELECT status, artifact_id FROM backups WHERE id = $1 AND site_id = $2', [request.params.backupId, site.id]);
      if (!backup.rows[0] || backup.rows[0]!.status !== 'succeeded') throw errors.conflict('backup.not_restorable');
      const dep = await db.query<{ id: string }>(
        "INSERT INTO deployments (site_id, version_id, artifact_id, backup_id, operation, status) VALUES ($1, $2, $3, $4, 'restore', 'pending') RETURNING id",
        [site.id, site.template_version_id, backup.rows[0]!.artifact_id, request.params.backupId],
      );
      const job = await enqueueSiteJob(db, 'site.restore', site.id, { backup_id: request.params.backupId, deployment_id: dep.rows[0]!.id }, auth.userId);
      await db.query('UPDATE deployments SET job_id = $2 WHERE id = $1', [dep.rows[0]!.id, job.id]);
      return { data: { deployment_id: dep.rows[0]!.id, job_id: job.id } };
    },
  );

  // ---- Dynamic content backups (docs/12) ----
  // A dynamic site's own backup unit is data/content.json — the file its
  // built-in admin downloads/restores. These endpoints give the BUYER the
  // same capability from their account: snapshot, download, restore from
  // a platform snapshot, or upload a JSON file (e.g. one downloaded from
  // the site's own admin) and restore it. Ownership: loadSiteForUser
  // with ownerOnly — the caller must own the site, which exists only
  // under their own entitlement; the platform never calls the site's
  // admin and never touches another tenant's directory. Restores are
  // step-up + name-confirmed, like whole-tree restores.
  async function loadDynamicSite(siteId: string, userId: string): Promise<SiteView> {
    const site = await loadSiteForUser(db, siteId, userId, true);
    const version = await db.query<{ adapter: string; manifest_json: { capabilities?: string[] } }>(
      'SELECT adapter, manifest_json FROM template_versions WHERE id = $1',
      [site.template_version_id],
    );
    const v = version.rows[0];
    if (!v || v.adapter === 'static-html' || v.adapter === 'vite-static' || !(v.manifest_json?.capabilities ?? []).includes('admin')) {
      throw errors.conflict('site.not_dynamic');
    }
    return site;
  }

  async function enqueueContentRestore(site: SiteView, backup: { id: string; artifact_id: string | null }, ownerId: string) {
    const dep = await db.query<{ id: string }>(
      "INSERT INTO deployments (site_id, version_id, artifact_id, backup_id, operation, status) VALUES ($1, $2, $3, $4, 'restore', 'pending') RETURNING id",
      [site.id, site.template_version_id, backup.artifact_id, backup.id],
    );
    const job = await enqueueSiteJob(db, 'site.content-restore', site.id, { backup_id: backup.id, deployment_id: dep.rows[0]!.id }, ownerId);
    await db.query('UPDATE deployments SET job_id = $2 WHERE id = $1', [dep.rows[0]!.id, job.id]);
    return { deployment_id: dep.rows[0]!.id, job_id: job.id };
  }

  app.post<{ Params: { id: string } }>('/sites/:id/content-backups', async (request, reply) => {
    const auth = requireUser(request);
    const site = await loadDynamicSite(request.params.id, auth.userId);
    if (site.status !== 'active' && site.status !== 'suspended') throw errors.conflict('site.not_backed_up');
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO backups (site_id, kind, expires_at) VALUES ($1, 'content', now() + interval '30 days') RETURNING id",
      [site.id],
    );
    const job = await enqueueSiteJob(db, 'site.content-backup', site.id, { backup_id: rows[0]!.id }, auth.userId);
    return reply.status(202).send({ data: { backupId: rows[0]!.id, jobId: job.id } });
  });

  app.get<{ Params: { id: string } }>('/sites/:id/content-backups', async (request) => {
    const auth = requireUser(request);
    const site = await loadDynamicSite(request.params.id, auth.userId);
    const { rows } = await db.query(
      "SELECT id, kind, status, checksum, created_at, expires_at FROM backups WHERE site_id = $1 AND kind = 'content' ORDER BY created_at DESC LIMIT 50",
      [site.id],
    );
    return { data: rows };
  });

  app.get<{ Params: { id: string; backupId: string } }>('/sites/:id/content-backups/:backupId/download', async (request, reply) => {
    const auth = requireUser(request);
    const site = await loadDynamicSite(request.params.id, auth.userId);
    assertId(request.params.backupId);
    const backup = await db.query<{ status: string; artifact_key: string | null }>(
      `SELECT b.status, a.object_key AS artifact_key FROM backups b LEFT JOIN artifacts a ON a.id = b.artifact_id
       WHERE b.id = $1 AND b.site_id = $2 AND b.kind = 'content'`,
      [request.params.backupId, site.id],
    );
    if (!backup.rows[0] || backup.rows[0]!.status !== 'succeeded' || !backup.rows[0]!.artifact_key) throw errors.notFound();
    reply.header('content-type', 'application/json');
    reply.header('content-disposition', `attachment; filename="content-${site.id.slice(0, 8)}.json"`);
    return reply.send(createReadStream(store.pathFor(backup.rows[0]!.artifact_key)));
  });

  app.post<{ Params: { id: string; backupId: string }; Body: { confirm_name: string } }>(
    '/sites/:id/content-backups/:backupId/restore',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['confirm_name'], properties: { confirm_name: { type: 'string' } } } } },
    async (request) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const site = await loadDynamicSite(request.params.id, auth.userId);
      if (request.body.confirm_name !== site.display_name) throw errors.validation([{ field: 'confirm_name', code: 'mismatch' }]);
      assertId(request.params.backupId);
      const backup = await db.query<{ status: string; artifact_id: string | null }>(
        "SELECT status, artifact_id FROM backups WHERE id = $1 AND site_id = $2 AND kind = 'content'",
        [request.params.backupId, site.id],
      );
      if (!backup.rows[0] || backup.rows[0]!.status !== 'succeeded') throw errors.conflict('backup.not_restorable');
      const result = await enqueueContentRestore(site, { id: request.params.backupId, artifact_id: backup.rows[0]!.artifact_id }, auth.userId);
      return { data: result };
    },
  );

  app.post<{ Params: { id: string }; Body: { content: unknown; confirm_name: string } }>(
    '/sites/:id/content-backups/restore-upload',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['content', 'confirm_name'],
          properties: { content: {}, confirm_name: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const site = await loadDynamicSite(request.params.id, auth.userId);
      if (request.body.confirm_name !== site.display_name) throw errors.validation([{ field: 'confirm_name', code: 'mismatch' }]);
      const invalid = validateDynamicContent(request.body.content);
      if (invalid) throw errors.validation([{ field: 'content', code: invalid }]);
      const raw = Buffer.from(JSON.stringify(request.body.content), 'utf8');
      if (raw.length > 5 * 1024 * 1024) throw errors.validation([{ field: 'content', code: 'too_large' }]);
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO backups (site_id, kind, expires_at) VALUES ($1, 'content', now() + interval '30 days') RETURNING id",
        [site.id],
      );
      const backupId = rows[0]!.id;
      const key = `content-backups/${site.id}/${backupId}.json`;
      const stored = await store.putStream(key, Readable.from([raw]), 16 * 1024 * 1024);
      const artifact = await db.query<{ id: string }>(
        `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
         VALUES ($1, $2, $3, 'application/json', 'site_content', 'permanent', $4) RETURNING id`,
        [key, stored.sha256, String(stored.size), { site_id: site.id, backup_id: backupId, uploaded: true }],
      );
      await db.query(
        "UPDATE backups SET status = 'succeeded', artifact_id = $2, checksum = $3 WHERE id = $1",
        [backupId, artifact.rows[0]!.id, stored.sha256],
      );
      const result = await enqueueContentRestore(site, { id: backupId, artifact_id: artifact.rows[0]!.id }, auth.userId);
      return reply.status(202).send({ data: { backup_id: backupId, ...result } });
    },
  );

  app.post<{ Params: { id: string } }>('/sites/:id/exports', async (request, reply) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status !== 'active' && site.status !== 'suspended') throw errors.conflict('site.not_backed_up');
    const created = await createBackup(site.id, auth.userId, 'export');
    return reply.status(202).send({ data: created });
  });

  app.get<{ Params: { id: string; backupId: string } }>('/sites/:id/exports/:backupId/download', async (request, reply) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    assertId(request.params.backupId);
    const backup = await db.query<{ status: string; kind: string; artifact_key: string | null }>(
      `SELECT b.status, b.kind, a.object_key AS artifact_key FROM backups b LEFT JOIN artifacts a ON a.id = b.artifact_id WHERE b.id = $1 AND b.site_id = $2`,
      [request.params.backupId, site.id],
    );
    if (!backup.rows[0] || backup.rows[0]!.status !== 'succeeded' || !backup.rows[0]!.artifact_key) throw errors.notFound();
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="site-export-${site.id.slice(0, 8)}.zip"`);
    return reply.send(createReadStream(store.pathFor(backup.rows[0]!.artifact_key)));
  });

  // ---- Members (C12) ----
  app.get<{ Params: { id: string } }>('/sites/:id/members', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId);
    const { rows } = await db.query(
      'SELECT m.user_id, m.role, u.email_normalized AS email FROM site_members m JOIN users u ON u.id = m.user_id WHERE m.site_id = $1 ORDER BY m.created_at',
      [site.id],
    );
    return { data: rows };
  });

  app.post<{ Params: { id: string }; Body: { email: string } }>(
    '/sites/:id/members',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
      const user = await db.query<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [request.body.email.trim().toLowerCase()]);
      if (!user.rows[0]) throw errors.validation([{ field: 'email', code: 'not_found' }]);
      if (user.rows[0]!.id === auth.userId) throw errors.conflict('site.already_member');
      try {
        await db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'member')", [site.id, user.rows[0]!.id]);
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict('site.already_member');
        throw error;
      }
      return reply.status(201).send({ data: { user_id: user.rows[0]!.id, role: 'member' } });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>('/sites/:id/members/:userId', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    assertId(request.params.userId);
    const member = await db.query<{ role: string }>('SELECT role FROM site_members WHERE site_id = $1 AND user_id = $2', [site.id, request.params.userId]);
    if (!member.rows[0]) throw errors.notFound();
    if (member.rows[0]!.role === 'owner') throw errors.conflict('site.last_owner');
    await db.query('DELETE FROM site_members WHERE site_id = $1 AND user_id = $2', [site.id, request.params.userId]);
    return { data: { status: 'removed' } };
  });

  // ---- Billing + delete schedule (C09/C15) ----
  app.get<{ Params: { id: string } }>('/sites/:id/billing', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    const subscription = await db.query('SELECT * FROM subscriptions WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1', [site.id]);
    const renewals = subscription.rows[0]
      ? await db.query('SELECT * FROM renewal_applications WHERE subscription_id = $1 ORDER BY applied_at DESC', [subscription.rows[0]!.id])
      : { rows: [] };
    return { data: { subscription: subscription.rows[0] ?? null, renewals: renewals.rows } };
  });

  app.post<{ Params: { id: string } }>('/sites/:id/delete-request', async (request) => {
    const auth = requireUser(request);
    await requireStepUp(db, auth);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status === 'purged' || site.status === 'delete_scheduled') throw errors.conflict('site.not_deletable');
    await db.query("UPDATE sites SET previous_status = $2, status = 'delete_scheduled', purge_at = now() + interval '30 days' WHERE id = $1", [site.id, site.status]);
    return { data: { status: 'delete_scheduled' } };
  });

  app.post<{ Params: { id: string } }>('/sites/:id/cancel-delete', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId, true);
    if (site.status !== 'delete_scheduled') throw errors.conflict('site.not_scheduled');
    await db.query("UPDATE sites SET status = COALESCE(previous_status, 'active'), previous_status = NULL, purge_at = NULL WHERE id = $1", [site.id]);
    return { data: { status: 'restored' } };
  });
}
