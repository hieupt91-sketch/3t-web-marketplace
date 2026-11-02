import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSetting } from '@3t/core';
import { DEFAULT_LOCALE, type Locale } from '@3t/i18n';
import { errors } from '../errors.ts';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface LocalizedRow {
  requested_title: string | null;
  requested_body: string | null;
  fallback_title: string | null;
  fallback_body: string | null;
}

function localize<T extends LocalizedRow>(row: T, locale: Locale) {
  const translated = row.requested_title !== null;
  return {
    title: translated ? row.requested_title : row.fallback_title,
    body: translated ? row.requested_body : row.fallback_body,
    requested_locale: locale,
    resolved_locale: translated ? locale : DEFAULT_LOCALE,
    translation_status: translated ? 'published' : row.fallback_title !== null ? 'fallback' : 'missing',
  };
}

const contactLimit = {
  rateLimit: {
    max: 5,
    timeWindow: '15 minutes',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => req.ip,
  },
};

export async function publicContentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // P05/P06/P07 — localized CMS page by slug (published only).
  app.get<{ Params: { slug: string } }>('/pages/public/:slug', async (request) => {
    if (!SLUG.test(request.params.slug)) throw errors.notFound();
    const { rows } = await db.query<LocalizedRow & { slug: string; kind: string }>(
      `SELECT p.slug, p.kind,
              rt.title AS requested_title, rt.body AS requested_body,
              ft.title AS fallback_title, ft.body AS fallback_body
       FROM platform_pages p
       LEFT JOIN platform_page_translations rt ON rt.page_id = p.id AND rt.locale = $1 AND rt.status = 'published'
       LEFT JOIN platform_page_translations ft ON ft.page_id = p.id AND ft.locale = '${DEFAULT_LOCALE}' AND ft.status = 'published'
       WHERE p.slug = $2 AND p.status = 'published'`,
      [request.locale, request.params.slug],
    );
    const row = rows[0];
    if (!row || (row.requested_title === null && row.fallback_title === null)) throw errors.notFound();
    return { data: { slug: row.slug, kind: row.kind, ...localize(row, request.locale) }, meta: { request_id: request.id, revision: null } };
  });

  // P06 — help index: published help pages with a title in the requested or default locale.
  app.get('/pages/help', async (request) => {
    const { rows } = await db.query<{ slug: string; title: string; resolved_locale: string }>(
      `SELECT p.slug, COALESCE(rt.title, ft.title) AS title,
              CASE WHEN rt.title IS NOT NULL THEN $1 ELSE '${DEFAULT_LOCALE}' END AS resolved_locale
       FROM platform_pages p
       LEFT JOIN platform_page_translations rt ON rt.page_id = p.id AND rt.locale = $1 AND rt.status = 'published'
       LEFT JOIN platform_page_translations ft ON ft.page_id = p.id AND ft.locale = '${DEFAULT_LOCALE}' AND ft.status = 'published'
       WHERE p.kind = 'help' AND p.status = 'published' AND COALESCE(rt.title, ft.title) IS NOT NULL
       ORDER BY title`,
      [request.locale],
    );
    return { data: rows, page: { next_cursor: null, has_more: false } };
  });

  // P08 — latest published policy effective now, or a specific version.
  async function policyResponse(request: FastifyRequest, code: string, version?: string) {
    if (!SLUG.test(code)) throw errors.notFound();
    const { rows } = await db.query<LocalizedRow & { version: string; effective_at: Date | null }>(
      `SELECT pv.version, pv.effective_at,
              rt.title AS requested_title, rt.body AS requested_body,
              ft.title AS fallback_title, ft.body AS fallback_body
       FROM policy_versions pv
       LEFT JOIN policy_translations rt ON rt.policy_version_id = pv.id AND rt.locale = $1 AND rt.review_status = 'published'
       LEFT JOIN policy_translations ft ON ft.policy_version_id = pv.id AND ft.locale = '${DEFAULT_LOCALE}' AND ft.review_status = 'published'
       WHERE pv.code = $2 AND pv.status = 'published'
         ${version ? 'AND pv.version = $3' : 'AND pv.effective_at <= now()'}
       ORDER BY pv.effective_at DESC NULLS LAST LIMIT 1`,
      version ? [(request as FastifyRequest).locale, code, version] : [(request as FastifyRequest).locale, code],
    );
    const row = rows[0];
    if (!row || (row.requested_title === null && row.fallback_title === null)) throw errors.notFound();
    return { data: { code, version: row.version, effective_at: row.effective_at?.toISOString() ?? null, ...localize(row, (request as FastifyRequest).locale) }, meta: { request_id: request.id, revision: null } };
  }

  app.get<{ Params: { code: string } }>('/policies/:code', (request) => policyResponse(request, request.params.code));
  app.get<{ Params: { code: string; version: string } }>('/policies/:code/versions/:version', (request) => policyResponse(request, request.params.code, request.params.version));

  // P09 — contact request. Honeypot + consent; response is generic (never confirms an order).
  app.post<{ Body: { name: string; email: string; body: string; consent: boolean; website?: string } }>(
    '/contact-requests',
    {
      config: contactLimit,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'email', 'body', 'consent'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: 'string', minLength: 3, maxLength: 254 },
            body: { type: 'string', minLength: 1, maxLength: 5000 },
            consent: { type: 'boolean' },
            website: { type: 'string', maxLength: 200 }, // honeypot: must stay empty
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const fieldErrors = [];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) fieldErrors.push({ field: 'email', code: 'invalid' });
      if (body.consent !== true) fieldErrors.push({ field: 'consent', code: 'required' });
      if (fieldErrors.length) throw errors.validation(fieldErrors);
      // Bots fill the hidden field; record as suspected rather than rejecting (avoids tipping them off).
      const spam = body.website && body.website.trim() !== '' ? 'suspected' : 'ok';
      const consentVersion = await getSetting<{ current: string }>(db, 'terms.version').then((v) => v.current).catch(() => 'terms-unknown');
      await db.query(
        `INSERT INTO contact_requests (name, email, body, locale, consent_version, spam_status) VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.name.trim(), body.email.trim().toLowerCase(), body.body.trim(), request.locale, consentVersion, spam],
      );
      return reply.status(202).send({ data: { status: 'received' } });
    },
  );
}
