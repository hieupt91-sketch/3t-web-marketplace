import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { loadActivePlans, previewOrigin, startingPrices, type PlatformConfig } from '@3t/core';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@3t/i18n';
import { ADAPTERS, IMPLEMENTED_ADAPTERS } from '@3t/template-sdk';
import { errors } from '../errors.ts';
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

const PLATFORM_CURRENCY = 'VND';
const DEPLOYMENT_MODES = ['selfhost', 'hosted'] as const;
const CAPABILITIES = ['landing', 'catalog', 'cms.pages', 'cms.products', 'cms.articles', 'cms.media', 'cms.translations', 'admin', 'contact', 'shop.cart', 'shop.checkout'];

/** Public demo info for a published template (docs/03 §7). Static templates expose a public readonly URL. */
function demoInfo(config: PlatformConfig, row: PublicTemplateRow) {
  const mode = row.manifest_json.demo?.mode ?? 'publicReadonly';
  // Only publicReadonly demos are exposed directly; isolatedAdmin demos need a session (POST /demo-sessions, D02).
  const available = row.demo_label !== null && mode === 'publicReadonly';
  return {
    available,
    mode,
    url: available ? `${previewOrigin(config, row.demo_label!)}/` : null,
    // Runtime templates demo through an isolated session: the web offers a
    // start link for the published version instead of a public URL.
    session: mode === 'isolatedAdmin',
    version_id: row.published_version_id,
  };
}

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
  published_version_id: string;
  created_at: Date;
  slug: string;
  manifest_json: { adapter?: string; export?: { modes?: string[] }; locales?: { supported?: string[] }; capabilities?: string[]; demo?: { mode?: string } };
  size_bytes: string | null;
  artifact_key: string | null;
  source_sha: string | null;
  demo_label: string | null;
  requested_title: string | null;
  requested_summary: string | null;
  requested_slug: string | null;
  fallback_title: string;
  fallback_summary: string | null;
  fallback_slug: string;
  category_code: string | null;
}

/**
 * Localised summary with explicit fallback metadata (docs/07 §3): when the requested locale has
 * no published translation the response says so instead of passing Vietnamese off as English.
 */
function toSummary(row: PublicTemplateRow, locale: Locale, config: PlatformConfig, startingPricesList: { deployment_mode: string; amount_minor: string; currency: string; interval: string }[] = [], previewImage: string | null = null) {
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
    category: row.category_code,
    preview_image: previewImage,
    adapter: row.manifest_json.adapter ?? null,
    size_bytes: row.size_bytes ?? null,
    modes: row.manifest_json.export?.modes ?? [],
    content_locales: row.manifest_json.locales?.supported ?? [],
    capabilities: row.manifest_json.capabilities ?? [],
    starting_prices: startingPricesList,
    demo: demoInfo(config, row),
  };
}

/**
 * The requested-locale translation is read via scalar subqueries, NOT a
 * LEFT JOIN. template_translations' primary key is (template_id, locale),
 * so a subquery returns exactly the row a join would. The join shape was
 * measurably fragile: when planner statistics for the table are missing or
 * stale (freshly imported/seeded data, before autovacuum analyzes), the
 * planner estimates ~1 row and serves the LEFT JOIN as a nested-loop join
 * filter over the whole translations table — 162ms vs 4ms for this query
 * on a 1,000-template seed, enough to fail the 50-concurrent catalog load
 * budget on its own. A scalar subquery is evaluated only for rows that
 * survive to the output page (like the demo_label subquery above), so its
 * cost is bounded by the page size under ANY statistics; with the
 * (template_id, locale, status) index from migration 0020 each evaluation
 * is a single index probe. The fallback translation stays a JOIN: it is a
 * required-row filter (a template without a published default-locale
 * translation is not listed), which a subquery cannot express.
 */
const RT_LOOKUP = (column: string) =>
  `(SELECT rt.${column} FROM template_translations rt WHERE rt.template_id = t.id AND rt.locale = $1 AND rt.status = 'published')`;

const TEMPLATE_SELECT = `
  SELECT t.id, t.published_version_id, t.created_at, t.slug, cat.code AS category_code, v.manifest_json, v.source_sha AS source_sha, a.size_bytes::text AS size_bytes, a.object_key AS artifact_key,
         (SELECT p.host_label FROM previews p
          WHERE p.version_id = t.published_version_id AND p.status = 'active' AND p.visibility = 'public' LIMIT 1) AS demo_label,
         ${RT_LOOKUP('title')} AS requested_title, ${RT_LOOKUP('summary')} AS requested_summary, ${RT_LOOKUP('slug')} AS requested_slug,
         ft.title AS fallback_title, ft.summary AS fallback_summary, ft.slug AS fallback_slug
  FROM templates t
  JOIN template_versions v ON v.id = t.published_version_id
  LEFT JOIN artifacts a ON a.id = v.artifact_id
  LEFT JOIN template_categories cat ON cat.id = t.category_id
  JOIN template_translations ft ON ft.template_id = t.id AND ft.locale = '${DEFAULT_LOCALE}' AND ft.status = 'published'
  WHERE t.status = 'published' AND NOT t.hidden`;

/** Hero photo candidates inside a built site tree, in preference order. */
const HERO_CANDIDATES = [
  'images/hero.jpg', 'images/hero.jpeg', 'images/hero.png', 'images/hero.webp',
  // Runtime (node-http) templates ship their hero under public/ instead.
  'public/images/hero.jpg', 'public/images/hero.jpeg', 'public/images/hero.png', 'public/images/hero.webp',
] as const;
const HERO_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/** First readable hero photo inside a stored artifact tree, or null when the
 *  published version ships no hero photo (then cards keep the gradient). */
async function heroFile(store: FastifyInstance['deps']['store'], artifactKey: string | null): Promise<{ path: string; mime: string } | null> {
  if (!artifactKey) return null;
  const base = store.pathFor(artifactKey);
  for (const file of HERO_CANDIDATES) {
    const full = resolve(base, file);
    if (!full.startsWith(base + sep)) continue;
    try {
      await access(full, constants.R_OK);
      return { path: full, mime: HERO_MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function previewImageUrl(slug: string): string {
  return `/api/v1/templates/${encodeURIComponent(slug)}/preview-image`;
}

/** Hero-existence probes cached in-process. A published version's artifact
 *  tree is immutable and content-addressed, so the result can never go stale
 *  for a given version: republishing points at a NEW version whose source_sha
 *  differs, which misses the cache and re-checks the filesystem.
 *
 *  The cache stores the in-flight PROMISE and is populated synchronously,
 *  before the probe's first await. Storing only the resolved value (the
 *  previous shape) let every concurrent caller miss and launch its own
 *  filesystem probe — measured on the release-load seed (50 concurrent
 *  list requests × 50 rows sharing one artifact): 2,500 calls ran 1,950
 *  probes (~15,600 fs.access calls) against 1 execution after this
 *  dedupe. Sharing one promise per key makes concurrent callers await the
 *  same probe — lock-free, and distinct keys still probe in parallel. */
const heroCache = new Map<string, Promise<{ path: string; mime: string } | null>>();

function heroFileCached(store: FastifyInstance['deps']['store'], artifactKey: string | null, sourceSha: string | null): Promise<{ path: string; mime: string } | null> {
  if (!artifactKey) return Promise.resolve(null);
  const key = `${artifactKey}|${sourceSha ?? ''}`;
  const hit = heroCache.get(key);
  if (hit !== undefined) return hit;
  if (heroCache.size >= 512) heroCache.clear(); // bound memory; entries are tiny
  // heroFile never rejects for a missing/unreadable hero (it resolves null);
  // the catch only guards a programming error (e.g. an invalid object key)
  // so one bad key cannot wedge the shared promise for other callers.
  const probe = heroFile(store, artifactKey).catch(() => null);
  heroCache.set(key, probe);
  return probe;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/config/public', async () => {
    const terms = await db.query<{ value_json: { current: string } }>("SELECT value_json FROM settings WHERE key = 'terms.version'");
    const contactRow = await db.query<{ value_json: { phone?: string; zalo?: string; messenger?: string; email?: string } }>("SELECT value_json FROM settings WHERE key = 'contact.channels'");
    const contactRaw = contactRow.rows[0]?.value_json ?? {};
    const contact = {
      phone: contactRaw.phone?.trim() || null,
      zalo: contactRaw.zalo?.trim() || null,
      messenger: contactRaw.messenger?.trim() || null,
      email: contactRaw.email?.trim() || null,
    };
    const feeRow = await db.query<{ value_json: { amount_minor?: number | null; period?: string } }>("SELECT value_json FROM settings WHERE key = 'subdomain.fee'");
    const feeRaw = feeRow.rows[0]?.value_json;
    const subdomain_fee = feeRaw
      ? { amount_minor: typeof feeRaw.amount_minor === 'number' ? feeRaw.amount_minor : null, period: feeRaw.period === 'monthly' ? 'monthly' : 'once' }
      : null;
    const payRow = await db.query<{ value_json: { enabled?: boolean; bank_name?: string; account_number?: string; account_holder?: string } }>("SELECT value_json FROM settings WHERE key = 'payment.bank_transfer'");
    const payRaw = payRow.rows[0]?.value_json;
    const bank_transfer_enabled = payRaw?.enabled === true
      && typeof payRaw.bank_name === 'string' && payRaw.bank_name.trim() !== ''
      && typeof payRaw.account_number === 'string' && payRaw.account_number.trim() !== ''
      && typeof payRaw.account_holder === 'string' && payRaw.account_holder.trim() !== '';
    const vnpRow = await db.query<{ value_json: { enabled?: boolean; tmn_code?: string; secret_key?: string } }>("SELECT value_json FROM settings WHERE key = 'payment.vnpay'");
    const vnpRaw = vnpRow.rows[0]?.value_json;
    const vnpay_enabled = vnpRaw?.enabled === true && typeof vnpRaw.tmn_code === 'string' && vnpRaw.tmn_code.trim() !== '' && typeof vnpRaw.secret_key === 'string' && vnpRaw.secret_key !== '';
    const momoRow = await db.query<{ value_json: { enabled?: boolean; partner_code?: string; access_key?: string; secret_key?: string } }>("SELECT value_json FROM settings WHERE key = 'payment.momo'");
    const momoRaw = momoRow.rows[0]?.value_json;
    const momo_enabled = momoRaw?.enabled === true && typeof momoRaw.partner_code === 'string' && momoRaw.partner_code.trim() !== '' && typeof momoRaw.access_key === 'string' && momoRaw.access_key.trim() !== '' && typeof momoRaw.secret_key === 'string' && momoRaw.secret_key !== '';
    return {
      data: {
        brand: { name: 'webmaket' },
        default_locale: DEFAULT_LOCALE,
        locales: LOCALES.filter((l) => l.enabled).map((l) => ({ code: l.code, display_name: l.displayNameNative, direction: l.direction })),
        currency: config.currency,
        terms_version: terms.rows[0]?.value_json.current ?? null,
        contact,
        subdomain_fee,
        payment: { bank_transfer: bank_transfer_enabled, vnpay: vnpay_enabled, momo: momo_enabled },
        adapters: ADAPTERS.map((code) => ({ code, status: IMPLEMENTED_ADAPTERS.includes(code) ? 'supported' : 'not_implemented' })),
      },
    };
  });

  app.get('/categories', async () => {
    const { rows } = await db.query<{ id: string; code: string; parent_id: string | null }>(
      'SELECT id, code, parent_id FROM template_categories ORDER BY code',
    );
    return { data: rows, page: { next_cursor: null, has_more: false } };
  });



  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string; locale?: string; mode?: string; capability?: string; category?: string; min_price?: string; max_price?: string } }>('/templates', async (request) => {
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const q = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
    const mode = DEPLOYMENT_MODES.includes(request.query.mode as (typeof DEPLOYMENT_MODES)[number]) ? request.query.mode : null;
    const capability = CAPABILITIES.includes(request.query.capability ?? '') ? request.query.capability : null;
    const minPrice = /^\d{1,18}$/.test(request.query.min_price ?? '') ? request.query.min_price! : null;
    const maxPrice = /^\d{1,18}$/.test(request.query.max_price ?? '') ? request.query.max_price! : null;
    const params: unknown[] = [request.locale];
    let sql = TEMPLATE_SELECT;
    if (q) {
      // Diacritic-insensitive (docs/07 §5): unaccent both sides so "da lat" matches "Đà Lạt".
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      sql += ` AND (unaccent(COALESCE(${RT_LOOKUP('title')}, ft.title)) ILIKE unaccent($${params.length}) OR unaccent(COALESCE(${RT_LOOKUP('summary')}, ft.summary)) ILIKE unaccent($${params.length}))`;
    }
    if (mode) {
      params.push(mode);
      sql += ` AND EXISTS (SELECT 1 FROM plans pl JOIN plan_prices pr ON pr.plan_id = pl.id
                           WHERE pl.template_id = t.id AND pl.status = 'active' AND pl.deployment_mode = $${params.length}
                             AND pr.currency = '${PLATFORM_CURRENCY}' AND pr.effective_from <= now() AND (pr.effective_to IS NULL OR pr.effective_to > now()))`;
    }
    if (capability) {
      params.push(JSON.stringify([capability]));
      sql += ` AND v.manifest_json -> 'capabilities' @> $${params.length}::jsonb`;
    }
    if (request.query.category) {
      // Category filter includes the whole subtree (children inherit the parent filter).
      params.push(request.query.category);
      sql += ` AND t.category_id IN (WITH RECURSIVE cats AS (
                  SELECT id FROM template_categories WHERE code = $${params.length}
                  UNION ALL SELECT c.id FROM template_categories c JOIN cats ON c.parent_id = cats.id)
                SELECT id FROM cats)`;
    }
    if (minPrice || maxPrice) {
      // Price filter compares the template's lowest current price (the "starting from" price shown on cards).
      const lowest = `(SELECT MIN(pp.amount_minor) FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id
                       WHERE p.template_id = t.id AND p.status = 'active' AND pp.currency = '${PLATFORM_CURRENCY}'
                         AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now()))`;
      if (minPrice) {
        params.push(minPrice);
        sql += ` AND ${lowest} >= $${params.length}`;
      }
      if (maxPrice) {
        params.push(maxPrice);
        sql += ` AND ${lowest} <= $${params.length}`;
      }
    }
    if (cursor) {
      params.push(cursor.t, cursor.id);
      sql += ` AND (t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    sql += ` ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`;
    const { rows } = await db.query<PublicTemplateRow>(sql, params);
    const prices = await startingPricesFor(db, rows.slice(0, limit).map((r) => r.id));
    const previews = new Map<string, string>();
    await Promise.all(rows.slice(0, limit).map(async (row) => {
      if (await heroFileCached(app.deps.store, row.artifact_key, row.source_sha)) previews.set(row.id, previewImageUrl(row.slug));
    }));
    return page(rows, limit, (row) => toSummary(row, request.locale, config, prices.get(row.id) ?? [], previews.get(row.id) ?? null));
  });

  app.get<{ Params: { id: string } }>('/plans/:id', async (request) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) throw errors.notFound();
    const { rows } = await db.query<{ template_id: string; template_status: string; template_hidden: boolean }>(
      `SELECT p.template_id, t.status AS template_status, t.hidden AS template_hidden FROM plans p JOIN templates t ON t.id = p.template_id
       WHERE p.id = $1 AND p.status = 'active'`,
      [request.params.id],
    );
    const plan = rows[0];
    if (!plan || plan.template_status !== 'published' || plan.template_hidden) throw errors.notFound();
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
    const hero = await heroFileCached(app.deps.store, row.artifact_key, row.source_sha);
    return {
      data: { ...toSummary(row, request.locale, config, startingPrices(plans), hero ? previewImageUrl(row.slug) : null), plans },
      meta: { request_id: request.id, revision: null },
    };
  });

  /** Public hero photo of the published version (the card image). No auth: the
   *  photo is part of the public demo. 404 when the version has no hero photo. */
  app.get<{ Params: { slug: string } }>('/templates/:slug/preview-image', async (request, reply) => {
    const slug = request.params.slug;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw errors.notFound();
    const { rows } = await db.query<{ artifact_key: string | null; source_sha: string | null }>(
      `SELECT a.object_key AS artifact_key, v.source_sha AS source_sha
       FROM templates t
       JOIN template_versions v ON v.id = t.published_version_id
       LEFT JOIN artifacts a ON a.id = v.artifact_id
       WHERE t.status = 'published' AND NOT t.hidden AND (t.slug = $1 OR EXISTS (
         SELECT 1 FROM template_translations x WHERE x.template_id = t.id AND x.slug = $1 AND x.status = 'published'))
       LIMIT 1`,
      [slug],
    );
    const row = rows[0];
    const hero = await heroFileCached(app.deps.store, row?.artifact_key ?? null, row?.source_sha ?? null);
    if (!row || !hero) throw errors.notFound();
    const etag = row.source_sha ? `"${row.source_sha}"` : null;
    if (etag && request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('content-type', hero.mime);
    reply.header('cache-control', 'public, max-age=86400');
    if (etag) reply.header('etag', etag);
    return reply.send(createReadStream(hero.path));
  });
}
