import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPage } from '@/lib/content-server';
import { RichText } from '@/components/rich-text';

type Props = { params: Promise<{ locale: Locale; slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const result = await fetchPage(slug, locale);
  if (!result.ok) return { title: translate(locale, 'ui.not_found.title'), robots: { index: false } };
  return { title: result.data.title ?? '', robots: result.data.translation_status === 'fallback' ? { index: false } : undefined, alternates: { canonical: `/${locale}/help/${slug}` } };
}

/** P06 — help article detail. */
export default async function HelpArticle({ params }: Props) {
  const { locale, slug } = await params;
  const t = (k: string) => translate(locale, k);
  const result = await fetchPage(slug, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.content.unavailable')}</p></div></div>;
  }
  const d = result.data;
  return (
    <div className="container container--form stack">
      <p><Link href={`/${locale}/help`}>← {t('ui.help.title')}</Link></p>
      <h1 lang={d.resolved_locale}>{d.title}</h1>
      {d.translation_status === 'fallback' ? <p className="badge badge--warning" lang="vi">{t('ui.catalog.fallback_vi')}</p> : null}
      <article lang={d.resolved_locale}>{d.body ? <RichText body={d.body} /> : null}</article>
    </div>
  );
}
