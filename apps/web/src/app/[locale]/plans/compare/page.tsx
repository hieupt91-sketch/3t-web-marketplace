import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ template?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: translate(locale, 'ui.compare.title'), robots: { index: false } };
}

function priceCell(plan: PublicPlan, locale: Locale): string {
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const one = plan.prices.find((p) => p.interval === 'one_time');
  const rec = plan.prices.find((p) => p.interval !== 'one_time');
  const parts: string[] = [];
  if (one) parts.push(`${formatMoney(one, locale)} ${plan.deployment_mode === 'hosted' ? t('ui.price.setup') : t('ui.price.one_time')}`);
  if (rec) parts.push(`${formatMoney(rec, locale)}/${t(`ui.price.per_${rec.interval}`)}`);
  return parts.join(' + ') || '—';
}

/** P04 — plan comparison. Rows state who does what per mode; no ambiguous checkboxes for source. */
export default async function ComparePage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { template: slug } = await searchParams;
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  if (!slug) notFound();
  const result = await fetchPublic<TemplateSummary & { plans: PublicPlan[] }>(`/templates/${encodeURIComponent(slug)}`, locale);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div></div>;
  }
  const plans = result.data.plans;
  const rows: { label: string; value: (p: PublicPlan) => string }[] = [
    { label: t('ui.compare.mode'), value: (p) => t(`ui.deployment.${p.deployment_mode}`) },
    { label: t('ui.compare.price'), value: (p) => priceCell(p, locale) },
    { label: t('ui.compare.who_hosts'), value: (p) => (p.deployment_mode === 'hosted' ? t('ui.compare.host_3t') : t('ui.compare.host_you')) },
    { label: t('ui.compare.source'), value: (p) => (p.deployment_mode === 'selfhost' ? t('ui.compare.source_yes') : t('ui.compare.source_no')) },
    { label: t('ui.plan.instances'), value: (p) => (typeof p.limits.instance_limit === 'number' ? String(p.limits.instance_limit) : '—') },
    { label: t('ui.compare.updates'), value: (p) => (typeof p.limits.updates_months === 'number' ? t('ui.plan.updates_months', { months: String(p.limits.updates_months) }) : '—') },
  ];
  return (
    <div className="container stack">
      <p><Link href={`/${locale}/templates/${result.data.slug}`}>← {result.data.title}</Link></p>
      <h1>{t('ui.compare.title')}</h1>
      {plans.length === 0 ? (
        <p className="muted">{t('ui.detail.no_plans')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.compare.attribute')}</th>
                {plans.map((p) => <th key={p.id} scope="col">{p.name[locale] ?? p.name.vi ?? p.code}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {plans.map((p) => <td key={p.id}>{row.value(p)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">{t('ui.detail.checkout_pending')}</p>
    </div>
  );
}
