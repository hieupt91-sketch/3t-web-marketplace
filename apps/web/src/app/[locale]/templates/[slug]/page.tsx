import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';
import { PriceBreakdown } from '@/components/price-breakdown';
import { coverGradient } from '@/components/template-card';

type Props = { params: Promise<{ locale: Locale; slug: string }> };

function formatSize(sizeBytes: string): string {
  const n = Number(sizeBytes);
  if (!Number.isFinite(n) || n < 0) return sizeBytes;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

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
  const result = await fetchPublic<TemplateSummary & { plans: PublicPlan[] }>(`/templates/${encodeURIComponent(slug)}`, locale);
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
      <div aria-hidden="true" style={{ height: 200, borderRadius: 'var(--radius-card)', background: coverGradient(template.slug), boxShadow: 'var(--shadow-card)' }} />
      <h1 lang={template.resolved_locale}>{template.title}</h1>
      {template.translation_status === 'fallback' ? <p className="badge badge--warning">{t('ui.catalog.fallback_vi')}</p> : null}
      {template.summary ? <p lang={template.resolved_locale}>{template.summary}</p> : null}
      {template.demo.available ? (
        <div className="row">
          <Link className="button" href={`/${locale}/demo/${template.slug}`}>{t('ui.catalog.view_demo')}</Link>
        </div>
      ) : null}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.detail.features')}</h2>
        <ul>{template.capabilities.map((c) => <li key={c}>{t(`ui.capability.${c.replace('.', '_')}`)}</li>)}</ul>
        <p className="muted">{t('ui.catalog.content_locales', { locales: template.content_locales.join(', ').toUpperCase() })}</p>
        {template.size_bytes ? <p className="muted">{t('ui.detail.package_size', { size: formatSize(template.size_bytes) })}</p> : null}
      </section>
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.detail.hosting_title')}</h2>
        <p style={{ margin: 0 }}>{template.adapter === 'node-http' || template.adapter === 'next-standalone' ? t('ui.detail.hosting_runtime') : t('ui.detail.hosting_static')}</p>
        <p style={{ margin: 0 }}><Link href={`/${locale}/help/help-hosting-choice`}>{t('ui.detail.hosting_guide')}</Link></p>
      </section>
      <section className="stack">
        <h2 style={{ marginBottom: 0 }}>{t('ui.detail.plans')}</h2>
        {template.plans.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('ui.detail.no_plans')}</p>
        ) : (
          <>
            <div className="grid-cards">
              {template.plans.map((plan) => <PriceBreakdown key={plan.id} plan={plan} locale={locale} />)}
            </div>
            <div className="row">
              <Link className="button" href={`/checkout/configure?template=${template.slug}`}>{t('ui.detail.choose_plan')}</Link>
              {template.plans.length > 1 ? <Link className="button button--secondary" href={`/${locale}/plans/compare?template=${template.slug}`}>{t('ui.detail.compare')}</Link> : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
