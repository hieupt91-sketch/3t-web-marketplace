import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ q?: string; cursor?: string; mode?: string; capability?: string; category?: string; min_price?: string; max_price?: string }> };

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
  const { q = '', cursor, mode = '', capability = '', category = '', min_price = '', max_price = '' } = await searchParams;
  const t = (key: string, p?: Record<string, string>) => translate(locale, key, p);
  const query = new URLSearchParams({ limit: '24' });
  if (q) query.set('q', q);
  if (MODES.includes(mode as (typeof MODES)[number])) query.set('mode', mode);
  if (CAPABILITIES.includes(capability as (typeof CAPABILITIES)[number])) query.set('capability', capability);
  if (category) query.set('category', category);
  if (/^\d+$/.test(min_price)) query.set('min_price', min_price);
  if (/^\d+$/.test(max_price)) query.set('max_price', max_price);
  if (cursor) query.set('cursor', cursor);
  const result = await fetchPublic<TemplateSummary[]>(`/templates?${query}`, locale);
  const categories = await fetchPublic<{ id: string; code: string; parent_id: string | null }[]>('/categories', locale);
  const base: Record<string, string> = { ...(q ? { q } : {}), ...(mode ? { mode } : {}), ...(capability ? { capability } : {}), ...(category ? { category } : {}), ...(min_price ? { min_price } : {}), ...(max_price ? { max_price } : {}) };
  const next = result.ok && result.page?.next_cursor ? `/${locale}/templates?${new URLSearchParams({ ...base, cursor: result.page.next_cursor })}` : null;
  const hasFilter = q || mode || capability || category || min_price || max_price;
  return (
    <div className="container stack">
      <h1>{t('ui.catalog.title')}</h1>
      <form className="stack" method="get" role="search">
        <div className="search">
          <label htmlFor="catalog-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
          <input id="catalog-search" className="input" type="search" name="q" defaultValue={q} placeholder={t('ui.catalog.search_placeholder')} />
          <button className="button" type="submit">{t('ui.catalog.search_action')}</button>
        </div>
        <div className="row">
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
          <label className="field" style={{ minWidth: 200 }}>
            <span>{t('ui.catalog.filter_category')}</span>
            <select className="select" name="category" defaultValue={category}>
              <option value="">{t('ui.catalog.filter_all')}</option>
              {categories.ok ? categories.data.map((c) => <option key={c.code} value={c.code}>{t(`ui.category.${c.code}`)}</option>) : null}
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
        </div>
      </form>
      {!result.ok ? (
        <div className="alert alert--error" role="alert">
          <p>{t('ui.catalog.unavailable')}</p>
          {result.requestId ? <p><small>{t('ui.error.request_id')}: <span className="mono">{result.requestId}</span></small></p> : null}
        </div>
      ) : result.data.length === 0 ? (
        <div className="card"><p style={{ margin: 0 }}>{hasFilter ? t('ui.catalog.empty_search', { q: q || t('ui.catalog.these_filters') }) : t('ui.catalog.empty_catalog')}</p></div>
      ) : (
        <>
          <p className="muted" role="status">{t('ui.catalog.result_count', { count: String(result.data.length) })}</p>
          <div className="grid-cards">
            {result.data.map((template) => <TemplateCard key={template.id} template={template} locale={locale} />)}
          </div>
          {next ? <p><Link className="button button--secondary" href={next}>{t('ui.catalog.more')}</Link></p> : null}
        </>
      )}
    </div>
  );
}
