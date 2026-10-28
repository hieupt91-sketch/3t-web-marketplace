import type { FastifyInstance } from 'fastify';
import { emitEvent, isUniqueViolation, previewOrigin, publishReadiness, tx, writeAudit, type Queryable } from '@3t/core';
import { DEFAULT_LOCALE } from '@3t/i18n';
import { requirePermission } from '../app.ts';
import { AppError, errors } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORM_CURRENCY = 'VND';
const LOCALES = ['vi', 'en'] as const;
const INTERVALS = ['one_time', 'monthly', 'yearly'] as const;

function requireIfMatch(header: string | undefined): number {
  const match = header?.match(/^(?:W\/)?"(\d+)"$/);
  if (!match) throw new AppError(428, 'request.if_match_required');
  return Number(match[1]);
}

function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

async function loadTemplate(db: Queryable, id: string, lock = false) {
  assertId(id);
  const { rows } = await db.query<{ id: string; slug: string; status: string; category_id: string | null; published_version_id: string | null; row_version: number }>(
    `SELECT id, slug, status, category_id, published_version_id, row_version FROM templates WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw errors.notFound();
  return rows[0];
}

/** amount in minor units as a non-negative integer string (docs/02 §4: never a float). */
function parseAmountMinor(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) throw errors.validation([{ field: 'amount_minor', code: 'invalid' }]);
  return String(BigInt(value));
}

export async function adminTemplateRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get<{ Params: { id: string } }>('/templates/:id/detail', async (request, reply) => {
    requirePermission(request, 'template:read');
    const template = await loadTemplate(db, request.params.id);
    const [translations, versions, plans, readiness] = await Promise.all([
      db.query(
        `SELECT locale, title, summary, description, slug, seo_title, seo_description, status, source_revision, updated_at
         FROM template_translations WHERE template_id = $1 ORDER BY locale`,
        [template.id],
      ),
      db.query(
        `SELECT v.id, v.semver, v.adapter, v.status, v.source_sha, v.created_at,
                (SELECT p.host_label FROM previews p WHERE p.version_id = v.id AND p.status = 'active' LIMIT 1) AS preview_label
         FROM template_versions v WHERE v.template_id = $1 ORDER BY v.created_at DESC`,
        [template.id],
      ),
      db.query(
        `SELECT p.id, p.code, p.deployment_mode, p.name_json, p.status, p.limits_json, p.row_version,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pp.id, 'currency', pp.currency, 'amount_minor', pp.amount_minor::text,
                          'interval', pp.interval, 'effective_from', pp.effective_from, 'effective_to', pp.effective_to) ORDER BY pp.effective_from DESC)
                          FROM plan_prices pp WHERE pp.plan_id = p.id), '[]'::jsonb) AS prices
         FROM plans p WHERE p.template_id = $1 ORDER BY p.deployment_mode, p.code`,
        [template.id],
      ),
      publishReadiness(db, template.id, DEFAULT_LOCALE, PLATFORM_CURRENCY),
    ]);
    // jsonb renders timestamptz with a +00:00 offset; the API contract is ISO 8601 UTC with Z.
    const toZ = (v: string | null) => (v ? new Date(v).toISOString() : null);
    const planRows = (plans.rows as { prices: { effective_from: string; effective_to: string | null }[] }[]).map((plan) => ({
      ...plan,
      prices: plan.prices.map((price) => ({ ...price, effective_from: toZ(price.effective_from), effective_to: toZ(price.effective_to) })),
    }));
    reply.header('etag', `"${template.row_version}"`);
    return {
      data: {
        id: template.id,
        slug: template.slug,
        status: template.status,
        category_id: template.category_id,
        published_version_id: template.published_version_id,
        translations: translations.rows,
        versions: versions.rows,
        plans: planRows,
        publish: readiness,
      },
      meta: { request_id: request.id, revision: template.row_version },
    };
  });

  // A07 — full versions screen: SHA, manifest, artifact, import, demo, published flag.
  // Same-semver-different-hash rejection is enforced at record time (AT-30); this
  // screen makes the SHA visible so the rejection is auditable.
  app.get<{ Params: { id: string } }>('/templates/:id/versions', async (request) => {
    requirePermission(request, 'template:read');
    const template = await loadTemplate(db, request.params.id);
    const { rows } = await db.query(
      `SELECT v.id, v.semver, v.adapter, v.status, v.source_sha, v.manifest_json, v.import_id, v.created_at,
              a.kind AS artifact_kind, a.size_bytes AS artifact_size, a.object_key AS artifact_key,
              (SELECT p.host_label FROM previews p WHERE p.version_id = v.id AND p.status = 'active' LIMIT 1) AS preview_label,
              (v.id = $2) AS is_published
       FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id
       WHERE v.template_id = $1 ORDER BY v.created_at DESC`,
      [template.id, template.published_version_id ?? ''],
    );
    return {
      data: rows.map((row) => ({
        ...row,
        demo_url: row.preview_label ? `${previewOrigin(config, row.preview_label)}/` : null,
      })),
    };
  });

  app.patch<{ Params: { id: string }; Body: { category_id: string | null } }>(
    '/templates/:id',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { category_id: { type: ['string', 'null'] } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:write');
      const expected = requireIfMatch(request.headers['if-match']);
      const next = await tx(db, async (client) => {
        const template = await loadTemplate(client, request.params.id, true);
        if (template.row_version !== expected) throw errors.preconditionFailed();
        if (request.body.category_id) {
          const cat = await client.query('SELECT 1 FROM template_categories WHERE id = $1', [request.body.category_id]);
          if (cat.rowCount === 0) throw errors.validation([{ field: 'category_id', code: 'not_found' }]);
        }
        const { rows } = await client.query<{ row_version: number }>(
          'UPDATE templates SET category_id = $2, row_version = row_version + 1 WHERE id = $1 RETURNING row_version',
          [template.id, request.body.category_id ?? null],
        );
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'template.updated', resourceType: 'template', resourceId: template.id, traceId: request.id, diff: request.body });
        return rows[0]!.row_version;
      });
      reply.header('etag', `"${next}"`);
      return { data: { status: 'updated' }, meta: { request_id: request.id, revision: next } };
    },
  );

  // A06/A22 — localized metadata. Editing a translation never overwrites another locale.
  app.put<{ Params: { id: string; locale: string }; Body: { title: string; summary?: string; description?: string; slug: string; seo_title?: string; seo_description?: string; status: 'draft' | 'reviewed' | 'published' } }>(
    '/templates/:id/translations/:locale',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'slug', 'status'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            summary: { type: 'string', maxLength: 500 },
            description: { type: 'string', maxLength: 20000 },
            slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 120 },
            seo_title: { type: 'string', maxLength: 200 },
            seo_description: { type: 'string', maxLength: 400 },
            status: { enum: ['draft', 'reviewed', 'published'] },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'translation:write');
      const { id, locale } = request.params;
      if (!LOCALES.includes(locale as (typeof LOCALES)[number])) throw errors.notFound();
      const body = request.body;
      try {
        const result = await tx(db, async (client) => {
          const template = await loadTemplate(client, id, true);
          const { rows } = await client.query<{ status: string; updated_at: Date }>(
            `INSERT INTO template_translations (template_id, locale, title, summary, description, slug, seo_title, seo_description, status, source_revision)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
             ON CONFLICT (template_id, locale) DO UPDATE SET
               title = EXCLUDED.title, summary = EXCLUDED.summary, description = EXCLUDED.description, slug = EXCLUDED.slug,
               seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, status = EXCLUDED.status
             RETURNING status, updated_at`,
            [template.id, locale, body.title.trim(), body.summary ?? null, body.description ?? null, body.slug, body.seo_title ?? null, body.seo_description ?? null, body.status],
          );
          await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'template.translation_saved', resourceType: 'template', resourceId: template.id, traceId: request.id, diff: { locale, status: body.status } });
          return rows[0]!;
        });
        return reply.status(200).send({ data: { locale, status: result.status, updated_at: result.updated_at.toISOString() } });
      } catch (error) {
        if (isUniqueViolation(error, 'template_translations_locale_slug_uq')) throw errors.conflict('translation.slug_taken');
        throw error;
      }
    },
  );

  // A08 — plans. A plan is created as a draft; it must have a current price before activation.
  app.post<{ Params: { id: string }; Body: { code: string; deployment_mode: 'selfhost' | 'hosted'; name: Record<string, string>; limits?: Record<string, unknown> } }>(
    '/templates/:id/plans',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'deployment_mode', 'name'],
          properties: {
            code: { type: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$', maxLength: 60 },
            deployment_mode: { enum: ['selfhost', 'hosted'] },
            name: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 120 }, propertyNames: { enum: ['vi', 'en'] }, minProperties: 1 },
            limits: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'pricing:write');
      const body = request.body;
      if (!(DEFAULT_LOCALE in body.name)) throw errors.validation([{ field: 'name', code: 'default_locale_required' }]);
      try {
        const plan = await tx(db, async (client) => {
          const template = await loadTemplate(client, request.params.id, true);
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [template.id, body.code, body.deployment_mode, body.name, body.limits ?? {}],
          );
          await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'plan.created', resourceType: 'plan', resourceId: rows[0]!.id, traceId: request.id, diff: { code: body.code, deployment_mode: body.deployment_mode } });
          return rows[0]!;
        });
        return reply.status(201).send({ data: { id: plan.id, status: 'draft' } });
      } catch (error) {
        if (isUniqueViolation(error, 'plans_template_code_uq')) throw errors.conflict('plan.code_taken');
        throw error;
      }
    },
  );

  app.patch<{ Params: { planId: string }; Body: { name?: Record<string, string>; limits?: Record<string, unknown>; status?: 'draft' | 'active' | 'archived' } }>(
    '/plans/:planId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 120 }, propertyNames: { enum: ['vi', 'en'] }, minProperties: 1 },
            limits: { type: 'object' },
            status: { enum: ['draft', 'active', 'archived'] },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'pricing:write');
      assertId(request.params.planId);
      const expected = requireIfMatch(request.headers['if-match']);
      const next = await tx(db, async (client) => {
        const { rows } = await client.query<{ id: string; template_id: string; deployment_mode: string; row_version: number }>(
          'SELECT id, template_id, deployment_mode, row_version FROM plans WHERE id = $1 FOR UPDATE',
          [request.params.planId],
        );
        const plan = rows[0];
        if (!plan) throw errors.notFound();
        if (plan.row_version !== expected) throw errors.preconditionFailed();
        // Activation requires a current price in the platform currency (otherwise the plan is invisible to buyers).
        if (request.body.status === 'active') {
          const priced = await client.query(
            `SELECT 1 FROM plan_prices WHERE plan_id = $1 AND currency = $2 AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`,
            [plan.id, PLATFORM_CURRENCY],
          );
          if (priced.rowCount === 0) throw errors.conflict('plan.no_current_price');
        }
        const updated = await client.query<{ row_version: number }>(
          `UPDATE plans SET name_json = COALESCE($2, name_json), limits_json = COALESCE($3, limits_json),
                  status = COALESCE($4, status), row_version = row_version + 1 WHERE id = $1 RETURNING row_version`,
          [plan.id, request.body.name ?? null, request.body.limits ?? null, request.body.status ?? null],
        );
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'plan.updated', resourceType: 'plan', resourceId: plan.id, traceId: request.id, diff: request.body });
        return updated.rows[0]!.row_version;
      });
      reply.header('etag', `"${next}"`);
      return { data: { status: 'updated' }, meta: { request_id: request.id, revision: next } };
    },
  );

  // A08 — add a price with an effective time; the previously open price of the same
  // (currency, interval) is capped at the new start, so existing orders keep their snapshot.
  app.post<{ Params: { planId: string }; Body: { currency?: string; amount_minor: string; interval: 'one_time' | 'monthly' | 'yearly'; effective_from?: string } }>(
    '/plans/:planId/prices',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amount_minor', 'interval'],
          properties: {
            currency: { enum: ['VND'] },
            amount_minor: { type: 'string' },
            interval: { enum: ['one_time', 'monthly', 'yearly'] },
            effective_from: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'pricing:write');
      assertId(request.params.planId);
      const amount = parseAmountMinor(request.body.amount_minor);
      const currency = request.body.currency ?? PLATFORM_CURRENCY;
      const interval = request.body.interval;
      if (!INTERVALS.includes(interval)) throw errors.validation([{ field: 'interval', code: 'invalid' }]);
      const from = request.body.effective_from ? new Date(request.body.effective_from) : new Date();
      if (Number.isNaN(from.getTime())) throw errors.validation([{ field: 'effective_from', code: 'invalid' }]);
      try {
        const price = await tx(db, async (client) => {
          const plan = await client.query<{ id: string }>('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [request.params.planId]);
          if (plan.rowCount === 0) throw errors.notFound();
          // Close any price that is open at `from` for the same key so ranges never overlap.
          await client.query(
            `UPDATE plan_prices SET effective_to = $4
             WHERE plan_id = $1 AND currency = $2 AND interval = $3
               AND effective_from < $4 AND (effective_to IS NULL OR effective_to > $4)`,
            [request.params.planId, currency, interval, from.toISOString()],
          );
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [request.params.planId, currency, amount, interval, from.toISOString()],
          );
          await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'plan.price_added', resourceType: 'plan', resourceId: request.params.planId, traceId: request.id, diff: { currency, amount_minor: amount, interval, effective_from: from.toISOString() } });
          return rows[0]!;
        });
        return reply.status(201).send({ data: { id: price.id, amount_minor: amount, currency, interval, effective_from: from.toISOString() } });
      } catch (error) {
        if (isUniqueViolation(error) || (error as { code?: string }).code === '23P01') throw errors.conflict('price.overlap');
        throw error;
      }
    },
  );

  // A09 — publish gates. Red gate blocks; publishing makes the ready version and its demo public.
  app.post<{ Params: { id: string } }>('/templates/:id/publish', async (request, reply) => {
    const auth = requirePermission(request, 'template:publish');
    const expected = requireIfMatch(request.headers['if-match']);
    const result = await tx(db, async (client) => {
      const template = await loadTemplate(client, request.params.id, true);
      if (template.row_version !== expected) throw errors.preconditionFailed();
      const readiness = await publishReadiness(client, template.id, DEFAULT_LOCALE, PLATFORM_CURRENCY);
      if (!readiness.ready) throw new AppError(409, 'template.publish_gate_failed', readiness.gates.filter((g) => !g.passed).map((g) => ({ field: g.code, code: 'gate_failed' })));
      const version = await client.query<{ id: string }>(
        `SELECT v.id FROM template_versions v JOIN previews p ON p.version_id = v.id AND p.status = 'active'
         WHERE v.template_id = $1 AND v.status IN ('ready', 'published') ORDER BY v.created_at DESC LIMIT 1`,
        [template.id],
      );
      const versionId = version.rows[0]!.id;
      await client.query("UPDATE template_versions SET status = 'published' WHERE id = $1 AND status = 'ready'", [versionId]);
      await client.query("UPDATE previews SET visibility = 'public' WHERE version_id = $1 AND status = 'active'", [versionId]);
      const updated = await client.query<{ row_version: number }>(
        "UPDATE templates SET status = 'published', published_version_id = $2, row_version = row_version + 1 WHERE id = $1 RETURNING row_version",
        [template.id, versionId],
      );
      await emitEvent(client, 'template.published', 'template', template.id, { template_id: template.id, version_id: versionId });
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'template.published', resourceType: 'template', resourceId: template.id, traceId: request.id, diff: { version_id: versionId } });
      return updated.rows[0]!.row_version;
    });
    reply.header('etag', `"${result}"`);
    return { data: { status: 'published' }, meta: { request_id: request.id, revision: result } };
  });

  // Archive stops new sales but keeps the published version for existing buyers (docs/04 §5).
  app.post<{ Params: { id: string } }>('/templates/:id/archive', async (request, reply) => {
    const auth = requirePermission(request, 'template:publish');
    const expected = requireIfMatch(request.headers['if-match']);
    const next = await tx(db, async (client) => {
      const template = await loadTemplate(client, request.params.id, true);
      if (template.row_version !== expected) throw errors.preconditionFailed();
      if (template.status !== 'published') throw errors.conflict('template.not_published');
      const updated = await client.query<{ row_version: number }>(
        "UPDATE templates SET status = 'archived', row_version = row_version + 1 WHERE id = $1 RETURNING row_version",
        [template.id],
      );
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'template.archived', resourceType: 'template', resourceId: template.id, traceId: request.id });
      return updated.rows[0]!.row_version;
    });
    reply.header('etag', `"${next}"`);
    return { data: { status: 'archived' }, meta: { request_id: request.id, revision: next } };
  });

  // Public category tree management is minimal for M3 (owner seeds categories).
  app.get('/categories', async (request) => {
    requirePermission(request, 'template:read');
    const { rows } = await db.query('SELECT id, code, parent_id FROM template_categories ORDER BY code');
    return { data: rows, page: { next_cursor: null, has_more: false } };
  });

  // Delete an uploaded landing page that was never sold. Safety rules,
  // mirroring the delete-failed-import scope:
  //  - the template must still be a draft with no published version;
  //  - every version must still be 'ready' (migration 0015 refuses
  //    deleting any other version status at the database level);
  //  - every import of the template must be terminal (no import may be
  //    mid-flight) and no queued/running job may point at one;
  //  - any commercial reference (order item, entitlement, download,
  //    site, deployment, demo session) on any version blocks it (409);
  //  - artifact rows and their stored blobs are immutable by design and
  //    are left untouched; everything relational (previews, capabilities,
  //    plans + prices, translations, versions, imports + their steps,
  //    logs, jobs, build runs, upload sessions, the template itself)
  //    is removed in one transaction.
  app.delete<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const auth = requirePermission(request, 'template:import');
    const result = await tx(db, async (client) => {
      const template = await loadTemplate(client, request.params.id, true);
      if (template.status !== 'draft' || template.published_version_id) throw errors.conflict('template.delete_blocked_published');
      const versions = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM template_versions WHERE template_id = $1', [template.id],
      );
      for (const v of versions.rows) {
        if (v.status !== 'ready') throw errors.conflict('template.delete_blocked_version');
      }
      const versionIds = versions.rows.map((v) => v.id);
      const imports = await client.query<{ id: string; status: string; upload_session_id: string | null }>(
        'SELECT id, status, upload_session_id FROM imports WHERE template_id = $1', [template.id],
      );
      for (const imp of imports.rows) {
        if (!['ready', 'failed', 'rejected', 'cancelled'].includes(imp.status)) throw errors.conflict('template.delete_blocked_running');
      }
      const importIds = imports.rows.map((i) => i.id);
      const running = await client.query(
        "SELECT 1 FROM jobs WHERE resource_type = 'import' AND resource_id = ANY($1::uuid[]) AND status IN ('queued', 'running') LIMIT 1",
        [importIds],
      );
      if (running.rowCount) throw errors.conflict('template.delete_blocked_running');
      if (versionIds.length) {
        const refs = await client.query(
          `SELECT 'order_items' AS src FROM order_items WHERE version_id = ANY($1::uuid[])
           UNION ALL SELECT 'order_items' FROM order_items WHERE template_id = $2
           UNION ALL SELECT 'entitlements' FROM entitlements WHERE version_id = ANY($1::uuid[])
           UNION ALL SELECT 'download_events' FROM download_events WHERE version_id = ANY($1::uuid[])
           UNION ALL SELECT 'sites' FROM sites WHERE template_version_id = ANY($1::uuid[])
           UNION ALL SELECT 'deployments' FROM deployments WHERE version_id = ANY($1::uuid[])
           UNION ALL SELECT 'demo_sessions' FROM demo_sessions WHERE version_id = ANY($1::uuid[])
           LIMIT 1`,
          [versionIds, template.id],
        );
        if (refs.rowCount) throw errors.conflict('template.delete_blocked_referenced');
      }
      const plans = await client.query<{ id: string }>('SELECT id FROM plans WHERE template_id = $1', [template.id]);
      const planIds = plans.rows.map((p) => p.id);
      if (planIds.length) {
        await client.query('DELETE FROM plan_prices WHERE plan_id = ANY($1::uuid[])', [planIds]);
        await client.query('DELETE FROM plans WHERE id = ANY($1::uuid[])', [planIds]);
      }
      if (importIds.length) {
        await client.query('DELETE FROM previews WHERE import_id = ANY($1::uuid[])', [importIds]);
      }
      if (versionIds.length) {
        await client.query('DELETE FROM previews WHERE version_id = ANY($1::uuid[])', [versionIds]);
        await client.query('DELETE FROM template_capabilities WHERE version_id = ANY($1::uuid[])', [versionIds]);
      }
      if (importIds.length) {
        await client.query('DELETE FROM import_steps WHERE import_id = ANY($1::uuid[])', [importIds]);
        await client.query('DELETE FROM import_logs WHERE import_id = ANY($1::uuid[])', [importIds]);
        await client.query('DELETE FROM build_runs WHERE import_id = ANY($1::uuid[])', [importIds]);
        await client.query('DELETE FROM github_webhook_deliveries WHERE import_id = ANY($1::uuid[])', [importIds]);
        await client.query("DELETE FROM jobs WHERE resource_type = 'import' AND resource_id = ANY($1::uuid[])", [importIds]);
      }
      // Mutual FKs (imports.version_id <-> template_versions.import_id and
      // imports.template_id -> templates) refuse deleting either side
      // while the other points at it, so break the imports' links first;
      // the import rows themselves go away below in the same transaction.
      if (importIds.length) {
        await client.query('UPDATE imports SET version_id = NULL, template_id = NULL WHERE id = ANY($1::uuid[])', [importIds]);
      }
      await client.query('DELETE FROM template_translations WHERE template_id = $1', [template.id]);
      await client.query('DELETE FROM template_versions WHERE template_id = $1', [template.id]);
      if (importIds.length) {
        await client.query('DELETE FROM imports WHERE id = ANY($1::uuid[])', [importIds]);
        const sessionIds = imports.rows.map((i) => i.upload_session_id).filter((s): s is string => !!s);
        if (sessionIds.length) await client.query('DELETE FROM upload_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
      }
      await client.query('DELETE FROM templates WHERE id = $1', [template.id]);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'template.deleted', resourceType: 'template', resourceId: template.id, traceId: request.id, diff: { slug: template.slug, versions: versionIds.length, imports: importIds.length, plans: planIds.length } });
      return { versions: versionIds.length, imports: importIds.length, plans: planIds.length, slug: template.slug };
    });
    return reply.send({ data: { resource_id: request.params.id, deleted: result } });
  });

}
