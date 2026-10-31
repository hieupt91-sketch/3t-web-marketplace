import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';
import { isDynamicAdapter } from '@/lib/template-kind';
import { DemoViewer } from '@/components/demo-viewer';

type Props = { params: Promise<{ locale: Locale; slug: string }> };

// Demo pages are never indexed (docs/07 §7).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: translate(locale, 'ui.demo.title'), robots: { index: false, follow: false } };
}

/** D01 — public demo for a published template. isolatedAdmin demos (runtime adapters) are not in v1. */
export default async function DemoPage({ params }: Props) {
  const { locale, slug } = await params;
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const result = await fetchPublic<TemplateSummary & { plans: PublicPlan[] }>(`/templates/${encodeURIComponent(slug)}`, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div></div>;
  }
  const template = result.data;
  return (
    <div className="container stack">
      <p><Link href={`/${locale}/templates/${template.slug}`}>← {template.title}</Link></p>
      <h1>{t('ui.demo.heading', { title: template.title })}</h1>
      <p style={{ margin: 0 }}>
        {isDynamicAdapter(template.adapter) ? (
          <span className="badge badge--info">{t('ui.catalog.badge_dynamic')}</span>
        ) : (
          <span className="badge badge--neutral">{t('ui.catalog.kind_static')}</span>
        )}
      </p>
      {template.demo.available && template.demo.url ? (
        <DemoViewer url={template.demo.url} title={template.title} slug={template.slug} />
      ) : template.demo.session ? (
        <div className="alert alert--info">
          <p>{t('ui.demo.start_body')}</p>
          <p><Link className="button" href={`/${locale}/demo/start/${template.demo.version_id}`}>{t('ui.catalog.view_demo_live')}</Link></p>
        </div>
      ) : (
        <div className="alert alert--info"><p>{t('ui.demo.unavailable')}</p></div>
      )}
    </div>
  );
}
