import type { MetadataRoute } from 'next';
import type { Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { fetchHelpIndex, fetchPage, fetchPolicy } from '@/lib/content-server';
import { siteBaseUrl } from '@/lib/seo';

const LOCALES: Locale[] = ['vi', 'en'];

/** CMS page slugs served by the public content routes (see components/content-page.tsx). */
const CMS_PAGE_SLUGS = ['how-it-works', 'partners'];
/** Policy document codes seeded by the platform (apps/web policies route). */
const POLICY_CODES = ['terms', 'privacy'];

/**
 * Locales in which a content document may be listed: only where its translation is actually
 * published — the same rule the page metadata enforces with its fallback noindex (docs/07 §7).
 */
async function publishedLocales(fetchOne: (locale: Locale) => Promise<{ ok: boolean; data?: { translation_status?: string } }>): Promise<Locale[]> {
  const published: Locale[] = [];
  for (const locale of LOCALES) {
    const result = await fetchOne(locale);
    if (result.ok && result.data?.translation_status === 'published') published.push(locale);
  }
  return published;
}

/** One sitemap entry per given locale for a locale-prefixed path, with hreflang alternates. */
function pairEntry(path: string, locales: Locale[], base: string, extra?: Partial<MetadataRoute.Sitemap[number]>): MetadataRoute.Sitemap {
  if (locales.length === 0) return [];
  const languages: Record<string, string> = {};
  for (const locale of locales) languages[locale] = `${base}/${locale}${path}`;
  languages['x-default'] = languages.vi ?? languages.en!;
  return locales.map((locale) => ({ url: `${base}/${locale}${path}`, alternates: { languages }, ...extra }));
}

/**
 * Sitemap of everything public and indexable: home, catalog, template detail pages, the help
 * index and its articles, the CMS pages (how-it-works, partners), the service-plan comparison,
 * the contact page and the
 * policy documents. A URL is listed for a locale only when that locale has a published
 * translation — never a fallback URL passed off as translated (docs/07 §7).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const BASE = siteBaseUrl();
  const entries: MetadataRoute.Sitemap = [];
  for (const locale of LOCALES) {
    entries.push(
      { url: `${BASE}/${locale}`, alternates: { languages: { vi: `${BASE}/vi`, en: `${BASE}/en`, 'x-default': `${BASE}/vi` } } },
      { url: `${BASE}/${locale}/templates`, changeFrequency: 'daily', priority: 0.9, alternates: { languages: { vi: `${BASE}/vi/templates`, en: `${BASE}/en/templates`, 'x-default': `${BASE}/vi/templates` } } },
    );
  }
  entries.push(...pairEntry('/help', LOCALES, BASE, { changeFrequency: 'weekly', priority: 0.7 }));
  entries.push(...pairEntry('/help/videos', LOCALES, BASE, { changeFrequency: 'monthly', priority: 0.6 }));
  entries.push(...pairEntry('/plans/compare', LOCALES, BASE, { changeFrequency: 'weekly', priority: 0.7 }));
  entries.push(...pairEntry('/contact', LOCALES, BASE, { priority: 0.5 }));

  // CMS pages — only in locales with a published translation.
  for (const slug of CMS_PAGE_SLUGS) {
    const locales = await publishedLocales((locale) => fetchPage(slug, locale));
    entries.push(...pairEntry(`/${slug}`, locales, BASE, { priority: 0.6 }));
  }

  // Help articles: union the slugs both locale indexes list, then keep published locales only.
  const helpSlugs = new Set<string>();
  for (const locale of LOCALES) {
    const index = await fetchHelpIndex(locale);
    if (index.ok) for (const article of index.data) helpSlugs.add(article.slug);
  }
  for (const slug of helpSlugs) {
    const locales = await publishedLocales((locale) => fetchPage(slug, locale));
    entries.push(...pairEntry(`/help/${slug}`, locales, BASE, { changeFrequency: 'monthly', priority: 0.6 }));
  }

  // Policy documents.
  for (const code of POLICY_CODES) {
    const locales = await publishedLocales((locale) => fetchPolicy(code, locale));
    entries.push(...pairEntry(`/policies/${code}`, locales, BASE, { changeFrequency: 'monthly', priority: 0.4 }));
  }

  // Collect published templates per locale (only a published translation is indexable in that locale).
  const bySlug = new Map<string, { vi?: string; en?: string }>();
  for (const locale of LOCALES) {
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const query: URLSearchParams = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
      const result: Awaited<ReturnType<typeof fetchPublic<TemplateSummary[]>>> = await fetchPublic<TemplateSummary[]>(`/templates?${query}`, locale);
      if (!result.ok) break;
      for (const tpl of result.data) {
        if (tpl.translation_status !== 'published') continue;
        const key = tpl.id;
        const current = bySlug.get(key) ?? {};
        current[locale] = `${BASE}/${locale}/templates/${tpl.slug}`;
        bySlug.set(key, current);
      }
      cursor = result.page?.next_cursor ?? null;
      if (!cursor) break;
    }
  }
  for (const urls of bySlug.values()) {
    const languages: Record<string, string> = {};
    if (urls.vi) languages.vi = urls.vi;
    if (urls.en) languages.en = urls.en;
    languages['x-default'] = urls.vi ?? urls.en!;
    for (const url of [urls.vi, urls.en].filter((u): u is string => Boolean(u))) {
      entries.push({ url, changeFrequency: 'weekly', priority: 0.8, alternates: { languages } });
    }
  }
  return entries;
}
