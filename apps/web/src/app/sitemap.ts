import type { MetadataRoute } from 'next';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

/**
 * Sitemap of indexable public URLs. A template detail URL is listed for a locale only when that
 * locale has a published translation — never a fallback URL passed off as translated (docs/07 §7).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];
  for (const locale of ['vi', 'en'] as const) {
    entries.push(
      { url: `${BASE}/${locale}`, alternates: { languages: { vi: `${BASE}/vi`, en: `${BASE}/en` } } },
      { url: `${BASE}/${locale}/templates`, alternates: { languages: { vi: `${BASE}/vi/templates`, en: `${BASE}/en/templates` } } },
    );
  }
  // Collect published templates per locale (only a published translation is indexable in that locale).
  const bySlug = new Map<string, { vi?: string; en?: string }>();
  for (const locale of ['vi', 'en'] as const) {
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
    for (const url of [urls.vi, urls.en].filter((u): u is string => Boolean(u))) {
      entries.push({ url, alternates: { languages } });
    }
  }
  return entries;
}
