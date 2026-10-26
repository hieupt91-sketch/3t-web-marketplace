import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolveTxt } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { enqueueJob, isUniqueViolation, tx, writeAudit } from '@3t/core';
import { requireUser } from '../app.ts';
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

function siteUrl(row: { runtime_port: number | null; subdomain: string | null }): string | null {
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

  app.get('/sites', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query(
      `SELECT s.*, sub.current_period_end AS subscription_end, sub.status AS subscription_status
       FROM sites s LEFT JOIN subscriptions sub ON sub.site_id = s.id AND sub.status IN ('active', 'grace')
       WHERE s.owner_id = $1 OR EXISTS (SELECT 1 FROM site_members m WHERE m.site_id = s.id AND m.user_id = $1)
       ORDER BY s.created_at DESC LIMIT 100`,
      [auth.userId],
    );
    return { data: rows.map((r) => ({ ...r, url: siteUrl(r) })) };
  });

  app.get<{ Params: { id: string } }>('/sites/:id', async (request) => {
    const auth = requireUser(request);
    const site = await loadSiteForUser(db, request.params.id, auth.userId);
    const [deployments, domains, subscription, template] = await Promise.all([
      db.query('SELECT * FROM deployments WHERE site_id = $1 ORDER BY created_at DESC LIMIT 20', [site.id]),
      db.query('SELECT id, hostname_ascii, status, is_primary, verified_at, cert_expires_at, created_at FROM domains WHERE site_id = $1 ORDER BY created_at DESC', [site.id]),
      db.query('SELECT * FROM subscriptions WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1', [site.id]),
      db.query<{ template_id: string }>('SELECT template_id FROM template_versions WHERE id = $1', [site.template_version_id]),
    ]);
    return { data: { ...site, url: siteUrl(site), template_id: template.rows[0]?.template_id ?? null, deployments: deployments.rows, domains: domains.rows, subscription: subscription.rows[0] ?? null } };
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
    const { rows } = await db.query('SELECT id, kind, status, checksum, created_at, expires_at FROM backups WHERE site_id = $1 ORDER BY created_at DESC LIMIT 50', [site.id]);
    return { data: rows };
  });

  app.post<{ Params: { id: string; backupId: string }; Body: { confirm_name: string } }>(
    '/sites/:id/backups/:backupId/restore',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['confirm_name'], properties: { confirm_name: { type: 'string' } } } } },
    async (request) => {
      const auth = requireUser(request);
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
