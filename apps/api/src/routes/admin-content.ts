import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isUniqueViolation, tx, writeAudit, type Queryable } from '@3t/core';
import { requirePermission } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCALES = ['vi', 'en'] as const;

function requireIfMatch(header: string | undefined): number {
  const match = header?.match(/^(?:W\/)?"(\d+)"$/);
  if (!match) throw new AppError(428, 'request.if_match_required');
  return Number(match[1]);
}
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

const translationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'status'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 50000 },
    seo_title: { type: 'string', maxLength: 200 },
    seo_description: { type: 'string', maxLength: 400 },
    status: { enum: ['draft', 'reviewed', 'published'] },
  },
} as const;

export async function adminContentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  async function loadPage(dbc: Queryable, id: string, lock = false) {
    assertId(id);
    const { rows } = await dbc.query<{ id: string; slug: string; kind: string; status: string; row_version: number }>(
      `SELECT id, slug, kind, status, row_version FROM platform_pages WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw errors.notFound();
    return rows[0];
  }

  // A27 — content pages list.
  app.get('/content/pages', async (request) => {
    requirePermission(request, 'content:read');
    const { rows } = await db.query(
      `SELECT p.id, p.slug, p.kind, p.status, p.updated_at,
              (SELECT jsonb_object_agg(t.locale, t.status) FROM platform_page_translations t WHERE t.page_id = p.id) AS locales
       FROM platform_pages p ORDER BY p.slug`,
    );
    return { data: rows, page: { next_cursor: null, has_more: false } };
  });

  app.post<{ Body: { slug: string; kind?: 'page' | 'help' } }>(
    '/content/pages',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['slug'], properties: { slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 120 }, kind: { enum: ['page', 'help'] } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'content:write');
      try {
        const { rows } = await db.query<{ id: string }>('INSERT INTO platform_pages (slug, kind) VALUES ($1, $2) RETURNING id', [request.body.slug, request.body.kind ?? 'page']);
        await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'content.page_created', resourceType: 'platform_page', resourceId: rows[0]!.id, traceId: request.id, diff: { slug: request.body.slug } });
        return reply.status(201).send({ data: { id: rows[0]!.id, status: 'draft' } });
      } catch (error) {
        if (isUniqueViolation(error, 'platform_pages_slug_uq')) throw errors.conflict('content.slug_taken');
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/content/pages/:id', async (request, reply) => {
    requirePermission(request, 'content:read');
    const pageRow = await loadPage(db, request.params.id);
    const translations = await db.query('SELECT locale, title, body, seo_title, seo_description, status, updated_at FROM platform_page_translations WHERE page_id = $1 ORDER BY locale', [pageRow.id]);
    reply.header('etag', `"${pageRow.row_version}"`);
    return { data: { ...pageRow, translations: translations.rows }, meta: { request_id: request.id, revision: pageRow.row_version } };
  });

  app.put<{ Params: { id: string; locale: string }; Body: { title: string; body?: string; seo_title?: string; seo_description?: string; status: 'draft' | 'reviewed' | 'published' } }>(
    '/content/pages/:id/translations/:locale',
    { schema: { body: translationBody } },
    async (request) => {
      const auth = requirePermission(request, 'content:write');
      const { id, locale } = request.params;
      if (!LOCALES.includes(locale as (typeof LOCALES)[number])) throw errors.notFound();
      const b = request.body;
      const result = await tx(db, async (client) => {
        await loadPage(client, id, true);
        const { rows } = await client.query<{ status: string; updated_at: Date }>(
          `INSERT INTO platform_page_translations (page_id, locale, title, body, seo_title, seo_description, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (page_id, locale) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
             seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, status = EXCLUDED.status
           RETURNING status, updated_at`,
          [id, locale, b.title.trim(), b.body ?? '', b.seo_title ?? null, b.seo_description ?? null, b.status],
        );
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'content.page_translation_saved', resourceType: 'platform_page', resourceId: id, traceId: request.id, diff: { locale, status: b.status } });
        return rows[0]!;
      });
      return { data: { locale, status: result.status, updated_at: result.updated_at.toISOString() } };
    },
  );

  // Publishing a page requires at least the default-locale translation to be published.
  app.post<{ Params: { id: string } }>('/content/pages/:id/publish', async (request, reply) => {
    const auth = requirePermission(request, 'content:publish');
    const expected = requireIfMatch(request.headers['if-match']);
    const next = await tx(db, async (client) => {
      const pageRow = await loadPage(client, request.params.id, true);
      if (pageRow.row_version !== expected) throw errors.preconditionFailed();
      const ok = await client.query("SELECT 1 FROM platform_page_translations WHERE page_id = $1 AND locale = 'vi' AND status = 'published'", [pageRow.id]);
      if (ok.rowCount === 0) throw errors.conflict('content.default_translation_required');
      const updated = await client.query<{ row_version: number }>("UPDATE platform_pages SET status = 'published', row_version = row_version + 1 WHERE id = $1 RETURNING row_version", [pageRow.id]);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'content.page_published', resourceType: 'platform_page', resourceId: pageRow.id, traceId: request.id });
      return updated.rows[0]!.row_version;
    });
    reply.header('etag', `"${next}"`);
    return { data: { status: 'published' }, meta: { request_id: request.id, revision: next } };
  });

  // Policies: create a draft version, translate it, then publish with an effective time.
  app.post<{ Body: { code: string; version: string } }>(
    '/content/policies',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'version'], properties: { code: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 60 }, version: { type: 'string', minLength: 1, maxLength: 40 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'policy:manage');
      try {
        const { rows } = await db.query<{ id: string }>('INSERT INTO policy_versions (code, version) VALUES ($1, $2) RETURNING id', [request.body.code, request.body.version]);
        await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'policy.version_created', resourceType: 'policy_version', resourceId: rows[0]!.id, traceId: request.id, diff: request.body });
        return reply.status(201).send({ data: { id: rows[0]!.id, status: 'draft' } });
      } catch (error) {
        if (isUniqueViolation(error, 'policy_versions_code_version_uq')) throw errors.conflict('policy.version_exists');
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/content/policies/:id', async (request) => {
    requirePermission(request, 'policy:manage');
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; code: string; version: string; status: string; effective_at: Date | null }>(
      'SELECT id, code, version, status, effective_at FROM policy_versions WHERE id = $1',
      [request.params.id],
    );
    if (!rows[0]) throw errors.notFound();
    const translations = await db.query('SELECT locale, title, body, review_status FROM policy_translations WHERE policy_version_id = $1 ORDER BY locale', [request.params.id]);
    return { data: { ...rows[0], effective_at: rows[0].effective_at?.toISOString() ?? null, translations: translations.rows }, meta: { request_id: request.id, revision: null } };
  });

  app.put<{ Params: { id: string; locale: string }; Body: { title: string; body?: string; status: 'draft' | 'reviewed' | 'published' } }>(
    '/content/policies/:id/translations/:locale',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['title', 'status'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', maxLength: 50000 }, status: { enum: ['draft', 'reviewed', 'published'] } } } } },
    async (request) => {
      const auth = requirePermission(request, 'policy:manage');
      const { id, locale } = request.params;
      assertId(id);
      if (!LOCALES.includes(locale as (typeof LOCALES)[number])) throw errors.notFound();
      const b = request.body;
      const { rows: pv } = await db.query<{ status: string }>('SELECT status FROM policy_versions WHERE id = $1', [id]);
      if (!pv[0]) throw errors.notFound();
      await db.query(
        `INSERT INTO policy_translations (policy_version_id, locale, title, body, review_status)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (policy_version_id, locale)
         DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, review_status = EXCLUDED.review_status`,
        [id, locale, b.title.trim(), b.body ?? '', b.status],
      );
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'policy.translation_saved', resourceType: 'policy_version', resourceId: id, traceId: request.id, diff: { locale, status: b.status } });
      return { data: { locale, status: b.status } };
    },
  );

  app.post<{ Params: { id: string }; Body: { effective_at?: string } }>(
    '/content/policies/:id/publish',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { effective_at: { type: 'string', format: 'date-time' } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'policy:manage');
      assertId(request.params.id);
      const effective = request.body.effective_at ? new Date(request.body.effective_at) : new Date();
      if (Number.isNaN(effective.getTime())) throw errors.validation([{ field: 'effective_at', code: 'invalid' }]);
      await tx(db, async (client) => {
        const { rows } = await client.query<{ status: string }>('SELECT status FROM policy_versions WHERE id = $1 FOR UPDATE', [request.params.id]);
        if (!rows[0]) throw errors.notFound();
        if (rows[0].status === 'published') throw errors.conflict('policy.already_published');
        const ok = await client.query("SELECT body FROM policy_translations WHERE policy_version_id = $1 AND locale = 'vi' AND review_status = 'published'", [request.params.id]);
        if (ok.rowCount === 0) throw errors.conflict('policy.default_translation_required');
        const bodyHash = createHash('sha256').update(String((ok.rows[0] as { body: string }).body)).digest('hex');
        await client.query("UPDATE policy_versions SET status = 'published', effective_at = $2, body_hash = $3 WHERE id = $1", [request.params.id, effective.toISOString(), bodyHash]);
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'policy.published', resourceType: 'policy_version', resourceId: request.params.id, traceId: request.id, diff: { effective_at: effective.toISOString() } });
      });
      return reply.status(200).send({ data: { status: 'published', effective_at: effective.toISOString() } });
    },
  );

  // W13/A26 — contact request inbox (lead handling).
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/content/contact-requests', async (request) => {
    requirePermission(request, 'support:read');
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const params: unknown[] = [];
    let where = '';
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where = `WHERE (created_at, id) < ($1::timestamptz, $2::uuid)`;
    }
    params.push(limit + 1);
    const { rows } = await db.query<{ id: string; name: string; email: string; body: string; locale: string; spam_status: string; status: string; created_at: Date }>(
      `SELECT id, name, email, body, locale, spam_status, status, created_at FROM contact_requests ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(rows, limit, (r) => ({ id: r.id, name: r.name, email: r.email, body: r.body, locale: r.locale, spam_status: r.spam_status, status: r.status, created_at: r.created_at.toISOString() }));
  });
}
