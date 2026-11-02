import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPage } from '@/lib/content-server';
import { RichText } from '@/components/rich-text';

/** Shared renderer for a CMS page by slug (P05 how-it-works, P07 partners). */
export async function contentPageMetadata(slug: string, locale: Locale): Promise<Metadata> {
  const result = await fetchPage(slug, locale);
  if (!result.ok) return { title: translate(locale, 'ui.not_found.title'), robots: { index: false } };
  return {
    title: result.data.title ?? translate(locale, 'ui.content.untitled'),
    robots: result.data.translation_status === 'fallback' ? { index: false, follow: true } : undefined,
    alternates: { canonical: `/${locale}/${slug}` },
  };
}

export async function ContentPageView({ slug, locale }: { slug: string; locale: Locale }) {
  const t = (k: string) => translate(locale, k);
  const result = await fetchPage(slug, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.content.unavailable')}</p></div></div>;
  }
  const pageData = result.data;
  return (
    <div className="container container--form stack">
      <h1 lang={pageData.resolved_locale}>{pageData.title}</h1>
      {pageData.translation_status === 'fallback' ? <p className="badge badge--warning" lang="vi">{t('ui.catalog.fallback_vi')}</p> : null}
      <article lang={pageData.resolved_locale}>{pageData.body ? <RichText body={pageData.body} /> : <p className="muted">{t('ui.content.empty')}</p>}</article>
    </div>
  );
}
