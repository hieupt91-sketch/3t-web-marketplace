import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPolicy } from '@/lib/content-server';
import { RichText } from '@/components/rich-text';

type Props = { params: Promise<{ locale: Locale; slug: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const result = await fetchPolicy(slug, locale);
  if (!result.ok) return { title: translate(locale, 'ui.not_found.title'), robots: { index: false } };
  return { title: result.data.title ?? '', robots: result.data.translation_status === 'fallback' ? { index: false } : undefined, alternates: { canonical: `/${locale}/policies/${slug}` } };
}

/** P08 — policy document (latest effective version). */
export default async function Policy({ params }: Props) {
  const { locale, slug } = await params;
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const result = await fetchPolicy(slug, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.content.unavailable')}</p></div></div>;
  }
  const d = result.data;
  return (
    <div className="container container--form stack">
      <h1 lang={d.resolved_locale}>{d.title}</h1>
      <p className="muted">{t('ui.policy.version', { version: d.version })}{d.effective_at ? ` · ${new Date(d.effective_at).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-GB')}` : ''}</p>
      {d.translation_status === 'fallback' ? <p className="badge badge--warning" lang="vi">{t('ui.catalog.fallback_vi')}</p> : null}
      <article lang={d.resolved_locale}>{d.body ? <RichText body={d.body} /> : null}</article>
    </div>
  );
}
