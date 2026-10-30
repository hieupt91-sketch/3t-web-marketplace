import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword, writeAudit } from '@3t/core';
import { requireUser } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { passwordIssues } from '../lib/identity.ts';
import { requireStepUp } from '../lib/step-up.ts';

function etagFor(rowVersion: number): string {
  return `"${rowVersion}"`;
}

function parseIfMatch(header: string | undefined): number | null {
  const match = header?.match(/^(?:W\/)?"(\d+)"$/);
  return match ? Number(match[1]) : null;
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer } = app.deps;

  // Authenticated password change (docs/04 §5): current password + step-up,
  // then every other session is revoked; the current session survives.
  app.post<{ Body: { current_password: string; new_password: string } }>(
    '/me/password-change',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['current_password', 'new_password'], properties: { current_password: { type: 'string', maxLength: 512 }, new_password: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const issues = passwordIssues(request.body.new_password, auth.email);
      if (issues.length) throw errors.validation(issues.map((code) => ({ field: 'new_password', code })));
      const { rows } = await db.query<{ password_hash: string | null; email_normalized: string; preferred_locale: string }>(
        'SELECT password_hash, email_normalized, preferred_locale FROM users WHERE id = $1',
        [auth.userId],
      );
      const user = rows[0];
      if (!user || !(await verifyPassword(request.body.current_password, user.password_hash))) {
        throw errors.unauthenticated('auth.invalid_credentials');
      }
      const passwordHash = await hashPassword(request.body.new_password, config.passwordHashCost);
      await db.query('UPDATE users SET password_hash = $2, row_version = row_version + 1 WHERE id = $1', [auth.userId, passwordHash]);
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'user.password_changed', resourceType: 'user', resourceId: auth.userId, traceId: request.id });
      await mailer.send({ to: user.email_normalized, locale: user.preferred_locale as 'vi' | 'en', template: 'password_changed', params: { link: `${config.portalOrigin}/auth/forgot-password` } });
      return reply.status(200).send({ data: { status: 'password_changed' } });
    },
  );

  app.get('/me', async (request, reply) => {
    const auth = requireUser(request);
    reply.header('etag', etagFor(auth.rowVersion));
    return {
      data: {
        id: auth.userId,
        email: auth.email,
        display_name: auth.displayName,
        verified: auth.verified,
        locale: auth.preferredLocale,
        timezone: auth.timezone,
        roles: auth.roles,
        permissions: [...auth.permissions].sort(),
      },
      meta: { request_id: request.id, revision: auth.rowVersion },
    };
  });

  app.patch<{ Body: { display_name?: string; locale?: 'vi' | 'en'; timezone?: string } }>(
    '/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            display_name: { type: 'string', minLength: 1, maxLength: 120 },
            locale: { enum: ['vi', 'en'] },
            timezone: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) throw new AppError(428, 'request.if_match_required');
      const body = request.body;
      if (body.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: body.timezone });
        } catch {
          throw errors.validation([{ field: 'timezone', code: 'invalid' }]);
        }
      }
      const { rows } = await db.query<{ row_version: number }>(
        `UPDATE users SET display_name = COALESCE($3, display_name), preferred_locale = COALESCE($4, preferred_locale),
                timezone = COALESCE($5, timezone), row_version = row_version + 1
         WHERE id = $1 AND row_version = $2 RETURNING row_version`,
        [auth.userId, expected, body.display_name?.trim() ?? null, body.locale ?? null, body.timezone ?? null],
      );
      if (!rows[0]) throw errors.preconditionFailed();
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'user.profile_updated', resourceType: 'user', resourceId: auth.userId, traceId: request.id, diff: body });
      reply.header('etag', etagFor(rows[0].row_version));
      return { data: { status: 'updated' }, meta: { request_id: request.id, revision: rows[0].row_version } };
    },
  );

  // ---- Saved templates (docs/12 CAT-08, ACC-06) ----
  // A template is saveable once it has been public (published or archived);
  // drafts were never visible to customers, so they 404 like unknown ids.
  // Availability is computed at read time: a saved template that is hidden
  // or loses its published version stays in the list, flagged unavailable.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  async function listSaved(userId: string) {
    const { rows } = await db.query<{ template_id: string; slug: string; saved_at: Date; template_status: string; available: boolean }>(
      `SELECT st.template_id, t.slug, st.created_at AS saved_at, t.status AS template_status,
              (t.status = 'published' AND NOT t.hidden AND EXISTS (SELECT 1 FROM template_versions v WHERE v.template_id = t.id AND v.status = 'published')) AS available
       FROM saved_templates st JOIN templates t ON t.id = st.template_id
       WHERE st.user_id = $1 ORDER BY st.created_at DESC LIMIT 200`,
      [userId],
    );
    return rows.map((r) => ({ template_id: r.template_id, slug: r.slug, saved_at: r.saved_at.toISOString(), template_status: r.template_status, available: r.available }));
  }

  async function saveableTemplate(templateId: string): Promise<boolean> {
    if (!UUID_RE.test(templateId)) return false;
    const { rows } = await db.query("SELECT 1 FROM templates WHERE id = $1 AND status IN ('published', 'archived')", [templateId]);
    return rows.length > 0;
  }

  app.get('/me/saved-templates', async (request) => {
    const auth = requireUser(request);
    return { data: await listSaved(auth.userId) };
  });

  app.post<{ Body: { template_id: string } }>(
    '/me/saved-templates',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_id'], properties: { template_id: { type: 'string', maxLength: 36 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (!(await saveableTemplate(request.body.template_id))) throw errors.notFound();
      const { rows } = await db.query(
        'INSERT INTO saved_templates (user_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING template_id',
        [auth.userId, request.body.template_id],
      );
      if (rows.length > 0) {
        await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'template.saved', resourceType: 'template', resourceId: request.body.template_id, traceId: request.id });
      }
      return reply.status(rows.length > 0 ? 201 : 200).send({ data: { template_id: request.body.template_id, saved: true } });
    },
  );

  app.delete<{ Params: { templateId: string } }>('/me/saved-templates/:templateId', async (request, reply) => {
    const auth = requireUser(request);
    if (!UUID_RE.test(request.params.templateId)) throw errors.notFound();
    const { rowCount } = await db.query('DELETE FROM saved_templates WHERE user_id = $1 AND template_id = $2', [auth.userId, request.params.templateId]);
    if ((rowCount ?? 0) > 0) {
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'template.unsaved', resourceType: 'template', resourceId: request.params.templateId, traceId: request.id });
    }
    return reply.status(204).send();
  });

  // Guest lists live in the browser (CAT-08); on sign-in the client posts
  // them here once. Unknown, draft and malformed ids are dropped silently —
  // the response is the authoritative merged list.
  app.post<{ Body: { template_ids: string[] } }>(
    '/me/saved-templates/merge',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_ids'], properties: { template_ids: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 36 } } } } } },
    async (request) => {
      const auth = requireUser(request);
      const wanted = [...new Set(request.body.template_ids.filter((id) => UUID_RE.test(id)))];
      let merged = 0;
      for (const templateId of wanted) {
        if (!(await saveableTemplate(templateId))) continue;
        const { rows } = await db.query(
          'INSERT INTO saved_templates (user_id, template_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING template_id',
          [auth.userId, templateId],
        );
        merged += rows.length;
      }
      if (merged > 0) {
        await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'template.saved_merged', resourceType: 'user', resourceId: auth.userId, traceId: request.id, diff: { merged } });
      }
      return { data: await listSaved(auth.userId) };
    },
  );

  /**
   * ACC-01 "việc cần làm": everything that needs the customer's action,
   * in the doc's priority order — orders awaiting payment, websites not
   * yet running, domains awaiting verification, plans expiring soon
   * (14-day window) or already in grace, support tickets waiting on the
   * customer, and hosted slots bought but not yet used. Read-only
   * aggregation over the customer's own rows; each group caps its items
   * at 5 but reports the true count. No prices are computed here — order
   * totals are the stored order values.
   */
  app.get('/me/todos', async (request) => {
    const auth = requireUser(request);
    const me = auth.userId;
    const memberOf = `s.owner_id = $1 OR EXISTS (SELECT 1 FROM site_members m WHERE m.site_id = s.id AND m.user_id = $1)`;
    const [payments, sites, domains, expiring, tickets, slots] = await Promise.all([
      db.query<{ order_id: string; total_minor: string; currency: string; expires_at: Date | null; created_at: Date; total: string }>(
        `SELECT id AS order_id, total_minor::text AS total_minor, currency, payment_window_expires_at AS expires_at, created_at, count(*) OVER ()::text AS total
         FROM orders WHERE buyer_id = $1 AND status = 'awaiting_payment' ORDER BY created_at LIMIT 5`,
        [me],
      ),
      db.query<{ site_id: string; display_name: string; subdomain: string | null; status: string; total: string }>(
        `SELECT s.id AS site_id, s.display_name, s.subdomain, s.status, count(*) OVER ()::text AS total
         FROM sites s WHERE (${memberOf}) AND s.status IN ('creating', 'provision_failed') ORDER BY s.created_at DESC LIMIT 5`,
        [me],
      ),
      db.query<{ domain_id: string; hostname: string; site_id: string; site_name: string; total: string }>(
        `SELECT d.id AS domain_id, d.hostname_ascii AS hostname, d.site_id, s.display_name AS site_name, count(*) OVER ()::text AS total
         FROM domains d JOIN sites s ON s.id = d.site_id WHERE (${memberOf}) AND d.status = 'pending' ORDER BY d.created_at LIMIT 5`,
        [me],
      ),
      db.query<{ site_id: string; site_name: string; subdomain: string | null; period_end: Date; sub_status: string; total: string }>(
        `SELECT sub.site_id, s.display_name AS site_name, s.subdomain, sub.current_period_end AS period_end, sub.status AS sub_status, count(*) OVER ()::text AS total
         FROM subscriptions sub JOIN sites s ON s.id = sub.site_id
         WHERE (${memberOf}) AND sub.status IN ('active', 'grace') AND sub.current_period_end <= now() + interval '14 days'
         ORDER BY sub.current_period_end LIMIT 5`,
        [me],
      ),
      db.query<{ ticket_id: string; subject: string; updated_at: Date; total: string }>(
        `SELECT id AS ticket_id, subject, updated_at, count(*) OVER ()::text AS total
         FROM support_tickets WHERE requester_id = $1 AND status = 'waiting' ORDER BY updated_at DESC LIMIT 5`,
        [me],
      ),
      db.query<{ entitlement_id: string; template_slug: string; free_slots: number; total: string }>(
        `SELECT e.id AS entitlement_id, t.slug AS template_slug,
                (e.instance_limit - (SELECT count(*) FROM sites sx WHERE sx.entitlement_id = e.id AND sx.status <> 'purged'))::int AS free_slots,
                count(*) OVER ()::text AS total
         FROM entitlements e JOIN templates t ON t.id = e.template_id
         WHERE e.user_id = $1 AND e.mode = 'hosted' AND e.status = 'active'
           AND (SELECT count(*) FROM sites sx WHERE sx.entitlement_id = e.id AND sx.status <> 'purged') < e.instance_limit
         ORDER BY e.created_at LIMIT 5`,
        [me],
      ),
    ]);
    const group = <T extends { total: string }>(kind: string, rows: T[]) =>
      rows.length === 0 ? null : { kind, count: Number(rows[0]!.total), items: rows.map(({ total: _total, ...item }) => item) };
    const groups = [
      group('payment_due', payments.rows),
      group('site_unfinished', sites.rows),
      group('domain_pending', domains.rows),
      group('subscription_expiring', expiring.rows),
      group('ticket_waiting', tickets.rows),
      group('hosted_slots_free', slots.rows),
    ].filter((g) => g !== null);
    return { data: { total: groups.reduce((sum, g) => sum + g.count, 0), groups } };
  });

  app.get('/me/sessions', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 100`,
      [auth.userId],
    );
    return {
      data: rows.map((s) => ({
        id: s.id,
        user_agent: s.user_agent,
        created_at: s.created_at.toISOString(),
        last_active_at: s.last_seen_at.toISOString(),
        expires_at: s.expires_at.toISOString(),
        current: s.id === auth.sessionId,
      })),
      page: { next_cursor: null, has_more: false },
    };
  });

  app.delete<{ Params: { id: string } }>('/me/sessions/:id', async (request, reply) => {
    const auth = requireUser(request);
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) throw errors.notFound();
    const { rowCount } = await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [request.params.id, auth.userId],
    );
    if (rowCount !== 1) throw errors.notFound();
    await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'session.revoked', resourceType: 'session', resourceId: request.params.id, traceId: request.id });
    return reply.status(204).send();
  });
}
