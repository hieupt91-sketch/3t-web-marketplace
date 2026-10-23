import type { FastifyInstance } from 'fastify';
import { loadActivePlans, startingPrices } from '@3t/core';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@3t/i18n';
import { ADAPTERS, IMPLEMENTED_ADAPTERS } from '@3t/template-sdk';
import { errors } from '../errors.ts';
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

const PLATFORM_CURRENCY = 'VND';

/** Lowest current price per (template, deployment_mode) for a set of templates, in one query. */
async function startingPricesFor(
  db: FastifyInstance['deps']['db'],
  templateIds: string[],
): Promise<Map<string, { deployment_mode: string; amount_minor: string; currency: string; interval: string }[]>> {
  const result = new Map<string, { deployment_mode: string; amount_minor: string; currency: string; interval: string }[]>();
  if (templateIds.length === 0) return result;
  const { rows } = await db.query<{ template_id: string; deployment_mode: string; amount_minor: string; interval: string }>(
    `SELECT DISTINCT ON (p.template_id, p.deployment_mode)
            p.template_id, p.deployment_mode, pp.amount_minor::text AS amount_minor, pp.interval
     FROM plans p
     JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $2
       AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
     WHERE p.template_id = ANY($1::uuid[]) AND p.status = 'active'
     ORDER BY p.template_id, p.deployment_mode, pp.amount_minor ASC`,
    [templateIds, PLATFORM_CURRENCY],
  );
  for (const row of rows) {
    const list = result.get(row.template_id) ?? [];
    list.push({ deployment_mode: row.deployment_mode, amount_minor: row.amount_minor, currency: PLATFORM_CURRENCY, interval: row.interval });
    result.set(row.template_id, list);
  }
  return result;
}

interface PublicTemplateRow {
  id: string;
  created_at: Date;
  slug: string;
  manifest_json: { export?: { modes?: string[] }; locales?: { supported?: string[] }; capabilities?: string[] };
  requested_title: string | null;
  requested_summary: string | null;
  requested_slug: string | null;
  fallback_title: string;
  fallback_summary: string | null;
  fallback_slug: string;
}

/**
 * Localised summary with explicit fallback metadata (docs/07 §3): when the requested locale has
 * no published translation the response says so instead of passing Vietnamese off as English.
 */
function toSummary(row: PublicTemplateRow, locale: Locale, startingPricesList: { deployment_mode: string; amount_minor: string; currency: string; interval: string }[] = []) {
  const translated = row.requested_title !== null;
  return {
    id: row.id,
    slug: translated ? row.requested_slug : row.fallback_slug,
    locale,
    requested_locale: locale,
    resolved_locale: translated ? locale : DEFAULT_LOCALE,
    translation_status: translated ? 'published' : 'fallback',
    title: translated ? row.requested_title : row.fallback_title,
    summary: translated ? row.requested_summary : row.fallback_summary,
    preview_image: null,
    modes: row.manifest_json.export?.modes ?? [],
    content_locales: row.manifest_json.locales?.supported ?? [],
    capabilities: row.manifest_json.capabilities ?? [],
    starting_prices: startingPricesList,
  };
}

const TEMPLATE_SELECT = `
  SELECT t.id, t.created_at, t.slug, v.manifest_json,
         rt.title AS requested_title, rt.summary AS requested_summary, rt.slug AS requested_slug,
         ft.title AS fallback_title, ft.summary AS fallback_summary, ft.slug AS fallback_slug
  FROM templates t
  JOIN template_versions v ON v.id = t.published_version_id
  JOIN template_translations ft ON ft.template_id = t.id AND ft.locale = '${DEFAULT_LOCALE}' AND ft.status = 'published'
  LEFT JOIN template_translations rt ON rt.template_id = t.id AND rt.locale = $1 AND rt.status = 'published'
  WHERE t.status = 'published'`;

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/config/public', async () => ({
    data: {
      brand: { name: '3T Web Marketplace' },
      default_locale: DEFAULT_LOCALE,
      locales: LOCALES.filter((l) => l.enabled).map((l) => ({ code: l.code, display_name: l.displayNameNative, direction: l.direction })),
      currency: 'VND',
      adapters: ADAPTERS.map((code) => ({ code, status: IMPLEMENTED_ADAPTERS.includes(code) ? 'supported' : 'not_implemented' })),
    },
  }));

  app.get('/categories', async () => {
    const { rows } = await db.query<{ id: string; code: string; parent_id: string | null }>(
      'SELECT id, code, parent_id FROM template_categories ORDER BY code',
    );
    return { data: rows, page: { next_cursor: null, has_more: false } };
  });

  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string; locale?: string } }>('/templates', async (request) => {
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const q = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
    const params: unknown[] = [request.locale];
    let sql = TEMPLATE_SELECT;
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      sql += ` AND (COALESCE(rt.title, ft.title) ILIKE $${params.length} OR COALESCE(rt.summary, ft.summary) ILIKE $${params.length})`;
    }
    if (cursor) {
      params.push(cursor.t, cursor.id);
      sql += ` AND (t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    sql += ` ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`;
    const { rows } = await db.query<PublicTemplateRow>(sql, params);
    const prices = await startingPricesFor(db, rows.slice(0, limit).map((r) => r.id));
    return page(rows, limit, (row) => toSummary(row, request.locale, prices.get(row.id) ?? []));
  });

  app.get<{ Params: { id: string } }>('/plans/:id', async (request) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) throw errors.notFound();
    const { rows } = await db.query<{ template_id: string; template_status: string }>(
      `SELECT p.template_id, t.status AS template_status FROM plans p JOIN templates t ON t.id = p.template_id
       WHERE p.id = $1 AND p.status = 'active'`,
      [request.params.id],
    );
    const plan = rows[0];
    if (!plan || plan.template_status !== 'published') throw errors.notFound();
    const plans = await loadActivePlans(db, plan.template_id, PLATFORM_CURRENCY);
    const found = plans.find((p) => p.id === request.params.id);
    if (!found) throw errors.notFound();
    return { data: found, meta: { request_id: request.id, revision: null } };
  });

  app.get<{ Params: { slug: string } }>('/templates/:slug', async (request) => {
    const slug = request.params.slug;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw errors.notFound();
    const { rows } = await db.query<PublicTemplateRow>(
      `${TEMPLATE_SELECT} AND (t.slug = $2 OR EXISTS (
         SELECT 1 FROM template_translations x WHERE x.template_id = t.id AND x.slug = $2 AND x.status = 'published'))`,
      [request.locale, slug],
    );
    const row = rows[0];
    if (!row) throw errors.notFound();
    const plans = await loadActivePlans(db, row.id, PLATFORM_CURRENCY);
    return {
      data: { ...toSummary(row, request.locale, startingPrices(plans)), plans },
      meta: { request_id: request.id, revision: null },
    };
  });
}
