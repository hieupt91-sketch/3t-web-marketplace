import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalObjectStore, escapeHtmlForm, extractEditCandidates, type Db } from '@3t/core';

/**
 * Serve-time SEO generation for hosted STATIC sites (spec:
 * ~/workspace/seo-statics/SPEC.md). A static bundle is frozen once, with
 * the freeze-time host baked into any absolute URL it may carry, so the
 * host-correct files can only be produced when the request arrives —
 * here, in the router, derived from the request Host exactly like the
 * SEO module inside every dynamic template (factory engine/server.mjs)
 * derives them from its live content. The builders below are ports of
 * that module's output, fed from the site's own data instead of a
 * content.json:
 *
 *   1. the buyer's one-time setup info (service_tasks.setup_info_json)
 *      when they have spent the setup right — their real business data;
 *   2. the template seed of the dynamic twin, restricted to the exact
 *      strings the visual-edit candidate extraction verifies against
 *      the site's own served homepage — i.e. what the visitor sees;
 *   3. the served homepage's own head (title / meta description / OG),
 *      then the buyer-chosen sites.display_name.
 *
 * Nothing is invented: no name, date or description is emitted that
 * does not come from one of those sources. Dynamic sites never pass
 * through here — their own server generates these files itself.
 */

/** Static adapters (mirrors apps/api/src/lib/template-twin.ts). */
export const STATIC_ADAPTERS: ReadonlySet<string> = new Set(['static-html', 'vite-static']);

export function isStaticAdapter(adapter: string | null | undefined): boolean {
  return adapter != null && STATIC_ADAPTERS.has(adapter);
}

/** The AI crawlers the dynamic fleet's robots.txt explicitly allows —
 *  same list, same order as factory engine/server.mjs AI_CRAWLERS. */
export const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'CCBot'];

const SCHEMA_TYPE_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const OPENING_HOURS_RE = /^[A-Za-z]{2}(-[A-Za-z]{2})?\s+\d{2}:\d{2}-\d{2}:\d{2}$/;

/**
 * Category → schema.org business type, mirroring the dynamic fleet:
 * for each factory pack category this is the businessType the largest
 * number of that category's packs declare in their own seo block
 * (measured across ~/workspace/factory/packs, 2026-11-04). Per-template
 * truth still wins whenever the twin seed is readable (its declared
 * seo.businessType); this map is only the category-level fallback, and
 * LocalBusiness the default — exactly the fleet's own fallback chain.
 */
export const CATEGORY_BUSINESS_TYPES: Readonly<Record<string, string>> = {
  agriculture: 'Store',
  automotive: 'AutoRepair',
  beauty: 'BeautySalon',
  blog: 'ProfessionalService',
  business: 'ProfessionalService',
  construction: 'HomeAndConstructionBusiness',
  crafts: 'Store',
  education: 'EducationalOrganization',
  energy: 'ProfessionalService',
  events: 'ProfessionalService',
  family: 'ProfessionalService',
  food: 'Restaurant',
  health: 'MedicalClinic',
  landing: 'ProfessionalService',
  logistics: 'ProfessionalService',
  pets: 'PetStore',
  portfolio: 'ProfessionalService',
  realestate: 'RealEstateAgent',
  sports: 'SportsActivityLocation',
  store: 'Store',
  technology: 'ProfessionalService',
  tourism: 'TravelAgency',
};

export interface SeoSiteFacts {
  siteId: string;
  templateId: string | null;
  templateVersionId: string | null;
  categoryCode: string | null;
  displayName: string;
}

/** The identity the four SEO outputs are generated from. Empty string
 *  means "not known from any source" — the field is then omitted from
 *  the outputs rather than filled with a guess. */
export interface SeoIdentity {
  nameVi: string;
  nameEn: string;
  descVi: string;
  descEn: string;
  phone: string;
  email: string;
  addressVi: string;
  addressEn: string;
  taglineVi: string;
  taglineEn: string;
  hoursVi: string;
  hoursEn: string;
  aboutVi: string;
  businessType: string;
  openingHours: string;
}

type Pair = { vi: string; en: string };

function pairOf(v: unknown): Pair {
  if (typeof v === 'string') return { vi: v.trim(), en: '' };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    return {
      vi: typeof rec.vi === 'string' ? rec.vi.trim() : '',
      en: typeof rec.en === 'string' ? rec.en.trim() : '',
    };
  }
  return { vi: '', en: '' };
}

function plainOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Identity strings carried by the served homepage's own head: the
 *  bilingual title / description the freeze rendered (data-vi/data-en,
 *  data-desc-vi/data-desc-en), with og: and plain fallbacks. These are
 *  by construction strings the site itself serves. */
export function identityFromHtmlHead(html: string): { title: Pair; description: Pair } {
  const title: Pair = { vi: '', en: '' };
  const description: Pair = { vi: '', en: '' };
  if (!html) return { title, description };
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) {
    const tag = titleMatch[0].slice(0, titleMatch[0].indexOf('>') + 1);
    const vi = /data-vi="([^"]*)"/i.exec(tag)?.[1];
    const en = /data-en="([^"]*)"/i.exec(tag)?.[1];
    title.vi = decodeEntities(vi ?? titleMatch[1]!.trim());
    title.en = decodeEntities(en ?? '');
  }
  if (!title.vi) {
    const og = /<meta[^>]+property="og:title"[^>]*>/i.exec(html)?.[0];
    const content = og ? /content="([^"]*)"/i.exec(og)?.[1] : undefined;
    if (content) title.vi = decodeEntities(content);
  }
  const metaDesc = /<meta[^>]+name="description"[^>]*>/i.exec(html)?.[0];
  if (metaDesc) {
    const vi = /data-desc-vi="([^"]*)"/i.exec(metaDesc)?.[1];
    const en = /data-desc-en="([^"]*)"/i.exec(metaDesc)?.[1];
    const content = /content="([^"]*)"/i.exec(metaDesc)?.[1];
    description.vi = decodeEntities(vi ?? content ?? '');
    description.en = decodeEntities(en ?? '');
  }
  if (!description.vi) {
    const og = /<meta[^>]+property="og:description"[^>]*>/i.exec(html)?.[0];
    const content = og ? /content="([^"]*)"/i.exec(og)?.[1] : undefined;
    if (content) description.vi = decodeEntities(content);
  }
  return { title, description };
}

interface SetupInfoShape {
  business_name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  about?: unknown;
  seo_description?: unknown;
}

/** The buyer's submitted one-time setup info for this site, via the
 *  same entitlement chain the API's visual-edit helpers use
 *  (site → entitlement → order item → order → installation task). */
async function loadSetupInfo(db: Db, siteId: string): Promise<SetupInfoShape | null> {
  const { rows } = await db.query<{ setup_info_json: SetupInfoShape | null }>(
    `SELECT st.setup_info_json
     FROM sites s
     JOIN entitlements e ON e.id = s.entitlement_id
     JOIN order_items oi ON oi.id = e.order_item_id
     JOIN service_tasks st ON st.order_id = oi.order_id AND st.kind = 'installation'
     WHERE s.id = $1 AND st.setup_info_json IS NOT NULL
     ORDER BY st.created_at
     LIMIT 1`,
    [siteId],
  );
  return rows[0]?.setup_info_json ?? null;
}

/** The published dynamic twin's version id (slug + '-dong' pairing,
 *  same query as the API's visual-edit helper). */
async function twinVersionId(db: Db, templateVersionId: string): Promise<string | null> {
  const { rows } = await db.query<{ published_version_id: string | null }>(
    `SELECT twin.published_version_id FROM template_versions v
     JOIN templates t ON t.id = v.template_id
     JOIN templates twin ON twin.slug = t.slug || '-dong' AND twin.status = 'published'
     WHERE v.id = $1`,
    [templateVersionId],
  );
  return rows[0]?.published_version_id ?? null;
}

async function artifactDir(db: Db, store: LocalObjectStore, versionId: string): Promise<string | null> {
  const { rows } = await db.query<{ object_key: string }>(
    'SELECT a.object_key FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1',
    [versionId],
  );
  if (!rows[0]) return null;
  try {
    return store.pathFor(rows[0].object_key);
  } catch {
    return null;
  }
}

/** The dynamic twin's seed (its public/seed.json), or null when the
 *  store is not readable from this process — the router then falls
 *  back to the served-HTML layer instead of failing. */
async function readTwinSeed(db: Db, storageDir: string | undefined, templateVersionId: string | null): Promise<Record<string, unknown> | null> {
  if (!storageDir || !templateVersionId) return null;
  const store = new LocalObjectStore(storageDir, { sharedGroupId: null });
  const versionId = await twinVersionId(db, templateVersionId).catch(() => null);
  if (!versionId) return null;
  const dir = await artifactDir(db, store, versionId).catch(() => null);
  if (!dir) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'public', 'seed.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadTemplateSummary(db: Db, templateId: string | null): Promise<Pair> {
  if (!templateId) return { vi: '', en: '' };
  const { rows } = await db.query<{ locale: string; summary: string | null }>(
    "SELECT locale, summary FROM template_translations WHERE template_id = $1 AND status = 'published'",
    [templateId],
  );
  const out: Pair = { vi: '', en: '' };
  for (const row of rows) {
    if (row.locale === 'vi') out.vi = (row.summary ?? '').trim();
    if (row.locale === 'en') out.en = (row.summary ?? '').trim();
  }
  return out;
}

export interface ResolveSeoIdentityDeps {
  db: Db;
  facts: SeoSiteFacts;
  /** Object-store root (config.storageDir); seed layer skipped when unset/unreadable. */
  storageDir?: string;
  /** The site's own served homepage HTML; '' when the upstream could not be read. */
  homepageHtml: string;
}

/**
 * Resolve the site's SEO identity from the spec's source priority:
 * setup info (buyer's real data) > twin seed strings verified present
 * in the served homepage (the visual-edit candidate logic) > the
 * served head itself > the buyer-chosen display name / the template's
 * catalog summary. Every layer only fills fields no earlier layer set.
 */
export async function resolveSeoIdentity(deps: ResolveSeoIdentityDeps): Promise<SeoIdentity> {
  const { db, facts } = deps;
  const identity: SeoIdentity = {
    nameVi: '', nameEn: '', descVi: '', descEn: '', phone: '', email: '',
    addressVi: '', addressEn: '', taglineVi: '', taglineEn: '', hoursVi: '', hoursEn: '',
    aboutVi: '',
    businessType: (facts.categoryCode && CATEGORY_BUSINESS_TYPES[facts.categoryCode]) || 'LocalBusiness',
    openingHours: '',
  };

  // Layer 2 (applied first, overridden by layer 1 below): the twin seed.
  const seed = await readTwinSeed(db, deps.storageDir, facts.templateVersionId);
  if (seed) {
    const seo = (seed.seo && typeof seed.seo === 'object' ? seed.seo : {}) as Record<string, unknown>;
    const declaredType = plainOf(seo.businessType);
    if (SCHEMA_TYPE_RE.test(declaredType)) identity.businessType = declaredType;
    const hours = plainOf(seo.openingHours);
    if (OPENING_HOURS_RE.test(hours)) identity.openingHours = hours;
    // Description: the seed's seo.description, else its ui.metaDesc —
    // the dynamic module's own fallback chain (seoOf).
    const seoDesc = pairOf(seo.description);
    const ui = (seed.ui && typeof seed.ui === 'object' ? seed.ui : {}) as Record<string, unknown>;
    const metaDesc = pairOf(ui.metaDesc);
    identity.descVi = seoDesc.vi || metaDesc.vi;
    identity.descEn = seoDesc.en || metaDesc.en;
    // Identity strings: only the ones the candidate extraction verifies
    // against the site's own served homepage (extractEditCandidates is
    // the shared @3t/core logic the visual editor uses).
    if (deps.homepageHtml) {
      const byId = new Map(extractEditCandidates(seed, deps.homepageHtml).map((c) => [c.id, c]));
      const take = (id: string): Pair | null => {
        const c = byId.get(id);
        return c && c.kind === 'text' ? { vi: c.vi ?? '', en: c.en ?? '' } : null;
      };
      const name = take('site.name');
      if (name) { identity.nameVi = name.vi; identity.nameEn = name.en; }
      const address = take('site.address');
      if (address) { identity.addressVi = address.vi; identity.addressEn = address.en; }
      const tagline = take('site.tagline');
      if (tagline) { identity.taglineVi = tagline.vi; identity.taglineEn = tagline.en; }
      const siteHours = take('site.hours');
      if (siteHours) { identity.hoursVi = siteHours.vi; identity.hoursEn = siteHours.en; }
      const capacity = take('site.capacity');
      if (capacity) identity.aboutVi = capacity.vi;
      const phone = take('site.phone');
      if (phone) identity.phone = phone.vi || phone.en;
      const email = take('site.email');
      if (email) identity.email = email.vi || email.en;
    }
  }

  // Layer 3: the served homepage's own head, then DB display data.
  const head = identityFromHtmlHead(deps.homepageHtml);
  if (!identity.nameVi && head.title.vi) identity.nameVi = head.title.vi;
  if (!identity.nameEn && head.title.en && head.title.en !== head.title.vi) identity.nameEn = head.title.en;
  if (!identity.descVi && head.description.vi) identity.descVi = head.description.vi;
  if (!identity.descEn && head.description.en) identity.descEn = head.description.en;
  if (!identity.nameVi) identity.nameVi = facts.displayName;
  if (!identity.descVi) {
    const summary = await loadTemplateSummary(db, facts.templateId).catch(() => ({ vi: '', en: '' }));
    identity.descVi = summary.vi;
    if (!identity.descEn) identity.descEn = summary.en;
  }

  // Layer 1 (wins): the buyer's one-time setup info.
  const setup = await loadSetupInfo(db, facts.siteId).catch(() => null);
  if (setup) {
    const businessName = plainOf(setup.business_name);
    if (businessName) identity.nameVi = businessName;
    const phone = plainOf(setup.phone);
    if (phone) identity.phone = phone;
    const email = plainOf(setup.email);
    if (email) identity.email = email;
    const address = plainOf(setup.address);
    if (address) identity.addressVi = address;
    const about = plainOf(setup.about);
    if (about) identity.aboutVi = about;
    const seoDescription = plainOf(setup.seo_description);
    if (seoDescription) identity.descVi = seoDescription;
  }

  return identity;
}

/** robots.txt — byte-for-byte the dynamic module's robotsTxt(). */
export function seoRobotsTxt(base: string): string {
  const groups = ['*', ...AI_CRAWLERS].map((ua) => `User-agent: ${ua}\nAllow: /`).join('\n\n');
  return `${groups}\n\nSitemap: ${base}/sitemap.xml\n`;
}

/** sitemap.xml — the dynamic module's sitemapXml(): one homepage URL;
 *  lastmod is a YYYY-MM-DD date the caller takes from a real DB stamp. */
export function seoSitemapXml(base: string, lastmod: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + `<url><loc>${escapeHtmlForm(`${base}/`)}</loc>` + (lastmod ? `<lastmod>${lastmod}</lastmod>` : '')
    + '<changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n';
}

/** JSON-LD LocalBusiness — the dynamic module's jsonLdScript() shape. */
export function seoJsonLdScript(identity: SeoIdentity, base: string): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': identity.businessType,
    name: identity.nameVi,
    url: `${base}/`,
  };
  if (identity.descVi) data.description = identity.descVi;
  if (identity.phone) data.telephone = identity.phone;
  if (identity.email) data.email = identity.email;
  if (identity.addressVi) data.address = { '@type': 'PostalAddress', streetAddress: identity.addressVi, addressCountry: 'VN' };
  if (identity.openingHours) data.openingHours = identity.openingHours;
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** Insert the JSON-LD script immediately before </head> — the same
 *  insertion point the dynamic engine uses. A page that already
 *  carries JSON-LD (e.g. a future re-frozen bundle) is left untouched,
 *  and a page without a </head> is served unchanged. */
export function injectSeoJsonLd(html: string, identity: SeoIdentity, base: string): string {
  if (!identity.nameVi) return html;
  if (html.includes('application/ld+json')) return html;
  const at = html.toLowerCase().indexOf('</head>');
  if (at === -1) return html;
  return html.slice(0, at) + seoJsonLdScript(identity, base) + html.slice(at);
}

/** llms.txt — the dynamic module's llmsTxt() line formats, minus the
 *  menu/spaces sections a frozen landing does not expose as data. */
export function seoLlmsTxt(identity: SeoIdentity, base: string): string {
  const L: string[] = [];
  L.push(`# ${identity.nameVi || 'Website'}`);
  if (identity.nameEn && identity.nameEn !== identity.nameVi) L.push(identity.nameEn);
  L.push('');
  if (identity.descVi) L.push(identity.descVi);
  if (identity.descEn && identity.descEn !== identity.descVi) L.push(identity.descEn);
  L.push('');
  L.push(`Website: ${base}/`);
  L.push(`Loại hình / Business type: ${identity.businessType}` + (identity.taglineVi ? ` — ${identity.taglineVi}` : ''));
  if (identity.addressVi) L.push(`Địa chỉ / Address: ${identity.addressVi}` + (identity.addressEn && identity.addressEn !== identity.addressVi ? ` | ${identity.addressEn}` : ''));
  if (identity.phone) L.push(`Điện thoại / Phone: ${identity.phone}`);
  if (identity.email) L.push(`Email: ${identity.email}`);
  const hoursText = identity.hoursVi ? identity.hoursVi + (identity.openingHours ? ` (${identity.openingHours})` : '') : identity.openingHours;
  if (hoursText) L.push(`Giờ mở cửa / Opening hours: ${hoursText}` + (identity.hoursEn && identity.hoursEn !== identity.hoursVi ? ` | ${identity.hoursEn}` : ''));
  if (identity.aboutVi) L.push(`Giới thiệu / About: ${identity.aboutVi}`);
  L.push('', `Sitemap: ${base}/sitemap.xml`);
  return `${L.join('\n')}\n`;
}
