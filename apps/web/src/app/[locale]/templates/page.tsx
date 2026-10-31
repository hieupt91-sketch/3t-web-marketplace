import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';
import { isDynamicAdapter } from '@/lib/template-kind';
import { DemoCatalog } from '@/components/demo-catalog';
import { CompareTray } from '@/components/compare-tray';
import { JsonLd } from '@/components/json-ld';
import { itemListJsonLd } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ q?: string; cursor?: string; mode?: string; capability?: string; category?: string; min_price?: string; max_price?: string; kind?: string }> };

const MODES = ['selfhost', 'hosted'] as const;
const CAPABILITIES = ['landing', 'catalog', 'contact', 'admin'] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.catalog.title'),
    alternates: { canonical: `/${locale}/templates`, languages: { vi: '/vi/templates', en: '/en/templates', 'x-default': '/vi/templates' } },
  };
}

/** P02 — template library with search and deployment-mode / capability / category / price filters (REQ-01). */
export default async function Templates({ params, searchParams }: Props) {
  const { locale } = await params;
  const { q = '', cursor, mode = '', capability = '', category = '', min_price = '', max_price = '', kind: rawKind = '' } = await searchParams;
  const kind = rawKind === 'static' || rawKind === 'dynamic' ? rawKind : '';
  const t = (key: string, p?: Record<string, string>) => translate(locale, key, p);
  const query = new URLSearchParams({ limit: '24' });
  if (q) query.set('q', q);
  if (kind) query.set('kind', kind);
  if (MODES.includes(mode as (typeof MODES)[number])) query.set('mode', mode);
  if (CAPABILITIES.includes(capability as (typeof CAPABILITIES)[number])) query.set('capability', capability);
  if (category) query.set('category', category);
  if (/^\d+$/.test(min_price)) query.set('min_price', min_price);
  if (/^\d+$/.test(max_price)) query.set('max_price', max_price);
  if (cursor) query.set('cursor', cursor);
  const result = await fetchPublic<TemplateSummary[]>(`/templates?${query}`, locale);
  const categories = await fetchPublic<{ id: string; code: string; parent_id: string | null }[]>('/categories', locale);
  // Category chips are the catalog's category filter: counts come from
  // one unfiltered list read (best-effort — chips render without counts
  // if it fails).
  const allForCounts = await fetchPublic<TemplateSummary[]>('/templates?limit=100', locale);
  const counts = new Map<string, number>();
  if (allForCounts.ok) {
    for (const tpl of allForCounts.data) counts.set(tpl.category ?? 'website', (counts.get(tpl.category ?? 'website') ?? 0) + 1);
  }
  const CATEGORY_ORDER = ['food', 'beauty', 'realestate', 'business', 'store', 'landing', 'portfolio', 'blog', 'website'];
  const chipCodes = categories.ok
    ? [...CATEGORY_ORDER.filter((c) => categories.data.some((x) => x.code === c)), ...categories.data.map((x) => x.code).filter((c) => !CATEGORY_ORDER.includes(c)).sort()]
    : [];
  const chipHref = (code: string) => `/${locale}/templates?${new URLSearchParams({ ...(q ? { q } : {}), ...(mode ? { mode } : {}), ...(capability ? { capability } : {}), ...(code ? { category: code } : {}), ...(min_price ? { min_price } : {}), ...(max_price ? { max_price } : {}), ...(kind ? { kind } : {}) })}`;
  const kindHref = (code: string) => `/${locale}/templates?${new URLSearchParams({ ...(q ? { q } : {}), ...(mode ? { mode } : {}), ...(capability ? { capability } : {}), ...(category ? { category } : {}), ...(min_price ? { min_price } : {}), ...(max_price ? { max_price } : {}), ...(code ? { kind: code } : {}) })}`;
  const dynamicCount = allForCounts.ok ? allForCounts.data.filter((tpl) => isDynamicAdapter(tpl.adapter)).length : 0;
  const staticCount = allForCounts.ok ? allForCounts.data.length - dynamicCount : 0;
  const base: Record<string, string> = { ...(q ? { q } : {}), ...(mode ? { mode } : {}), ...(capability ? { capability } : {}), ...(category ? { category } : {}), ...(min_price ? { min_price } : {}), ...(max_price ? { max_price } : {}), ...(kind ? { kind } : {}) };
  const next = result.ok && result.page?.next_cursor ? `/${locale}/templates?${new URLSearchParams({ ...base, cursor: result.page.next_cursor })}` : null;
  const hasFilter = q || mode || capability || category || min_price || max_price || kind;
  return (
    <div className="container stack">
      {result.ok && result.data.length > 0 ? <JsonLd data={itemListJsonLd(result.data, locale)} /> : null}
      <h1>{t('ui.catalog.title')}</h1>
      <form className="search" method="get" role="search">
        {mode ? <input type="hidden" name="mode" value={mode} /> : null}
        {capability ? <input type="hidden" name="capability" value={capability} /> : null}
        {category ? <input type="hidden" name="category" value={category} /> : null}
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        {min_price ? <input type="hidden" name="min_price" value={min_price} /> : null}
        {max_price ? <input type="hidden" name="max_price" value={max_price} /> : null}
        <label htmlFor="catalog-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
        <input id="catalog-search" className="input" type="search" name="q" defaultValue={q} placeholder={t('ui.catalog.search_placeholder')} />
        <button className="button" type="submit">{t('ui.catalog.search_action')}</button>
      </form>
      <nav className="kind-nav" aria-label={t('ui.catalog.filter_kind')}>
        <Link className={`kind-nav__item${kind === '' ? ' kind-nav__item--active' : ''}`} href={kindHref('')}>
          {t('ui.catalog.filter_all')}
          {allForCounts.ok ? <span className="kind-nav__count">{allForCounts.data.length}</span> : null}
        </Link>
        <Link className={`kind-nav__item${kind === 'static' ? ' kind-nav__item--active' : ''}`} href={kindHref('static')}>
          {t('ui.catalog.kind_static')}
          {allForCounts.ok ? <span className="kind-nav__count">{staticCount}</span> : null}
        </Link>
        <Link className={`kind-nav__item${kind === 'dynamic' ? ' kind-nav__item--active' : ''}`} href={kindHref('dynamic')}>
          {t('ui.catalog.kind_dynamic')}
          {allForCounts.ok ? <span className="kind-nav__count">{dynamicCount}</span> : null}
        </Link>
      </nav>
      {chipCodes.length > 0 ? (
        <nav className="cat-nav" aria-label={t('ui.catalog.filter_category')}>
          <Link className={`cat-chip${category === '' ? ' cat-chip--active' : ''}`} href={chipHref('')}>
            {t('ui.catalog.filter_all')}
            {allForCounts.ok ? <span className="cat-chip__count">{allForCounts.data.length}</span> : null}
          </Link>
          {chipCodes.map((code) => {
            const label = t(`ui.category.${code}`);
            return (
              <Link key={code} className={`cat-chip${category === code ? ' cat-chip--active' : ''}`} href={chipHref(code)}>
                {label === `ui.category.${code}` ? code : label}
                {counts.has(code) ? <span className="cat-chip__count">{counts.get(code)}</span> : null}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="catalog-layout">
        <aside className="catalog-layout__filters card stack">
          <form className="stack" method="get">
            <input type="hidden" name="q" value={q} />
            {category ? <input type="hidden" name="category" value={category} /> : null}
            {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          <label className="field" style={{ minWidth: 200 }}>
            <span>{t('ui.catalog.filter_mode')}</span>
            <select className="select" name="mode" defaultValue={mode}>
              <option value="">{t('ui.catalog.filter_all')}</option>
              {MODES.map((m) => <option key={m} value={m}>{t(`ui.deployment.${m}`)}</option>)}
            </select>
          </label>
          <label className="field" style={{ minWidth: 200 }}>
            <span>{t('ui.catalog.filter_capability')}</span>
            <select className="select" name="capability" defaultValue={capability}>
              <option value="">{t('ui.catalog.filter_all')}</option>
              {CAPABILITIES.map((c) => <option key={c} value={c}>{t(`ui.capability.${c.replace('.', '_')}`)}</option>)}
            </select>
          </label>
          <label className="field" style={{ minWidth: 140 }}>
            <span>{t('ui.catalog.filter_min_price')}</span>
            <input className="input" type="number" min="0" name="min_price" defaultValue={min_price} placeholder="0" />
          </label>
          <label className="field" style={{ minWidth: 140 }}>
            <span>{t('ui.catalog.filter_max_price')}</span>
            <input className="input" type="number" min="0" name="max_price" defaultValue={max_price} placeholder="0" />
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <button className="button button--secondary" type="submit">{t('ui.catalog.apply_filter')}</button>
            {hasFilter ? <Link className="button button--secondary" href={`/${locale}/templates`}>{t('ui.catalog.reset')}</Link> : null}
          </div>
          </form>
        </aside>
        <div className="stack">
      {!result.ok ? (
        <div className="alert alert--error" role="alert">
          <p>{t('ui.catalog.unavailable')}</p>
          {result.requestId ? <p><small>{t('ui.error.request_id')}: <span className="mono">{result.requestId}</span></small></p> : null}
        </div>
      ) : result.data.length === 0 ? (
        <>
          <div className="card"><p style={{ margin: 0 }}>{hasFilter ? t('ui.catalog.empty_search', { q: q || t('ui.catalog.these_filters') }) : t('ui.catalog.empty_catalog')}</p></div>
          {hasFilter ? null : <DemoCatalog locale={locale} />}
        </>
      ) : (
        <>
          <p className="muted" role="status">{t('ui.catalog.result_count', { count: String(result.data.length) })}</p>
          <div className="grid-cards">
            {result.data.map((template) => <TemplateCard key={template.id} template={template} locale={locale} comparable />)}
          </div>
          {next ? <p><Link className="button button--secondary" href={next}>{t('ui.catalog.more')}</Link></p> : null}
        </>
      )}
        </div>
      </div>
      <CompareTray locale={locale} />
    </div>
  );
}
