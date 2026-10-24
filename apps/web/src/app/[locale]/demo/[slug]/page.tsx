import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';
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
      {template.demo.available && template.demo.url ? (
        <DemoViewer url={template.demo.url} title={template.title} />
      ) : (
        <div className="alert alert--info"><p>{t('ui.demo.unavailable')}</p></div>
      )}
    </div>
  );
}
