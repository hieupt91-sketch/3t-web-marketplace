import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';

type Props = { params: Promise<{ locale: Locale; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const result = await fetchPublic<TemplateSummary>(`/templates/${encodeURIComponent(slug)}`, locale);
  if (!result.ok) return { title: translate(locale, 'ui.not_found.title'), robots: { index: false } };
  // A fallback (untranslated) page is not indexable in this locale (docs/07 §3).
  return {
    title: result.data.title,
    description: result.data.summary ?? undefined,
    robots: result.data.translation_status === 'fallback' ? { index: false, follow: true } : undefined,
    alternates: { canonical: `/${locale}/templates/${result.data.slug}` },
  };
}

/** P03 — template detail. Plans/checkout arrive with M3/M4; nothing here pretends to sell. */
export default async function TemplateDetail({ params }: Props) {
  const { locale, slug } = await params;
  const t = (key: string, p?: Record<string, string>) => translate(locale, key, p);
  const result = await fetchPublic<TemplateSummary & { plans: unknown[] }>(`/templates/${encodeURIComponent(slug)}`, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <div className="container">
        <div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div>
      </div>
    );
  }
  const template = result.data;
  return (
    <div className="container stack">
      <h1 lang={template.resolved_locale}>{template.title}</h1>
      {template.translation_status === 'fallback' ? <p className="badge badge--warning">{t('ui.catalog.fallback_vi')}</p> : null}
      {template.summary ? <p lang={template.resolved_locale}>{template.summary}</p> : null}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.detail.features')}</h2>
        <ul>{template.capabilities.map((c) => <li key={c}>{t(`ui.capability.${c.replace('.', '_')}`)}</li>)}</ul>
        <p className="muted">{t('ui.catalog.content_locales', { locales: template.content_locales.join(', ').toUpperCase() })}</p>
      </section>
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.detail.plans')}</h2>
        <p className="muted" style={{ margin: 0 }}>{t('ui.detail.no_plans')}</p>
      </section>
    </div>
  );
}
