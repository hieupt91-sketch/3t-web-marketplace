import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ q?: string; cursor?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.catalog.title'),
    alternates: { canonical: `/${locale}/templates`, languages: { vi: '/vi/templates', en: '/en/templates', 'x-default': '/vi/templates' } },
  };
}

/** P02 — template library. Only search is offered until category/price filters exist in the API. */
export default async function Templates({ params, searchParams }: Props) {
  const { locale } = await params;
  const { q = '', cursor } = await searchParams;
  const t = (key: string, p?: Record<string, string>) => translate(locale, key, p);
  const query = new URLSearchParams({ limit: '24' });
  if (q) query.set('q', q);
  if (cursor) query.set('cursor', cursor);
  const result = await fetchPublic<TemplateSummary[]>(`/templates?${query}`, locale);
  const next = result.ok && result.page?.next_cursor ? `/${locale}/templates?${new URLSearchParams({ ...(q ? { q } : {}), cursor: result.page.next_cursor })}` : null;
  return (
    <div className="container stack">
      <h1>{t('ui.catalog.title')}</h1>
      <form className="search" method="get" role="search">
        <label htmlFor="catalog-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
        <input id="catalog-search" className="input" type="search" name="q" defaultValue={q} placeholder={t('ui.catalog.search_placeholder')} />
        <button className="button" type="submit">{t('ui.catalog.search_action')}</button>
        {q ? <Link className="button button--secondary" href={`/${locale}/templates`}>{t('ui.catalog.reset')}</Link> : null}
      </form>
      {!result.ok ? (
        <div className="alert alert--error" role="alert">
          <p>{t('ui.catalog.unavailable')}</p>
          {result.requestId ? <p><small>{t('ui.error.request_id')}: <span className="mono">{result.requestId}</span></small></p> : null}
        </div>
      ) : result.data.length === 0 ? (
        <div className="card"><p style={{ margin: 0 }}>{q ? t('ui.catalog.empty_search', { q }) : t('ui.catalog.empty_catalog')}</p></div>
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
