import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';
import { isDynamicAdapter } from '@/lib/template-kind';
import { languageAlternates } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ template?: string }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale } = await params;
  const { template } = await searchParams;
  // The per-template view is a utility comparison for one template: noindex.
  // The general view is a public content page (docs/12 §7): indexable.
  if (template) return { title: translate(locale, 'ui.compare.title'), robots: { index: false } };
  return {
    title: translate(locale, 'ui.plans.title'),
    alternates: { canonical: `/${locale}/plans/compare`, languages: languageAlternates('/plans/compare') },
  };
}

function priceCell(plan: PublicPlan, locale: Locale, storagePerGb?: number | null): string {
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const one = plan.prices.find((p) => p.interval === 'one_time');
  const rec = plan.prices.find((p) => p.interval !== 'one_time');
  const parts: string[] = [];
  if (one) parts.push(`${formatMoney(one, locale)} ${plan.deployment_mode === 'hosted' ? t('ui.price.setup') : t('ui.price.one_time')}`);
  if (plan.deployment_mode === 'hosted' && typeof storagePerGb === 'number' && storagePerGb > 0) {
    // Storage-priced hosting (v33): checkout charges rate x GB, not the flat price.
    parts.push(`${formatMoney({ amount_minor: String(storagePerGb), currency: plan.prices[0]?.currency ?? 'VND' }, locale)}/GB/${t('ui.price.per_monthly')}`);
  } else if (rec) parts.push(`${formatMoney(rec, locale)}/${t(`ui.price.per_${rec.interval}`)}`);
  return parts.join(' + ') || '—';
}

/** P04 — per-template plan comparison. Rows state who does what per mode; no ambiguous checkboxes for source. */
async function TemplateCompare({ locale, slug }: { locale: Locale; slug: string }) {
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const [result, cfg] = await Promise.all([
    fetchPublic<TemplateSummary & { plans: PublicPlan[] }>(`/templates/${encodeURIComponent(slug)}`, locale),
    fetchPublic<PublicConfigShape>('/config/public', locale),
  ]);
  const storagePerGb = cfg.ok ? cfg.data.hosting_storage?.per_gb_minor ?? null : null;
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <div className="container"><div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div></div>;
  }
  const plans = result.data.plans;
  const rows: { label: string; value: (p: PublicPlan) => string }[] = [
    { label: t('ui.compare.mode'), value: (p) => t(`ui.deployment.${p.deployment_mode}`) },
    { label: t('ui.compare.price'), value: (p) => priceCell(p, locale, storagePerGb) },
    { label: t('ui.compare.who_hosts'), value: (p) => (p.deployment_mode === 'hosted' ? t('ui.compare.host_3t') : t('ui.compare.host_you')) },
    { label: t('ui.compare.source'), value: (p) => (p.deployment_mode === 'selfhost' ? t('ui.compare.source_yes') : t('ui.compare.source_no')) },
    { label: t('ui.plan.instances'), value: (p) => (typeof p.limits.instance_limit === 'number' ? String(p.limits.instance_limit) : '—') },
    { label: t('ui.compare.updates'), value: (p) => (typeof p.limits.updates_months === 'number' ? t('ui.plan.updates_months', { months: String(p.limits.updates_months) }) : '—') },
  ];
  return (
    <div className="container stack">
      <p><Link href={`/${locale}/templates/${result.data.slug}`}>← {result.data.title}</Link></p>
      <h1>{t('ui.compare.title')}</h1>
      <p style={{ margin: 0 }}>
        {isDynamicAdapter(result.data.adapter) ? (
          <span className="badge badge--info">{t('ui.catalog.badge_dynamic')}</span>
        ) : (
          <span className="badge badge--neutral">{t('ui.catalog.kind_static')}</span>
        )}
      </p>
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

interface PublicConfigShape {
  subdomain_fee: { amount_minor: number | null; period: string } | null;
  hosting_storage?: { per_gb_minor: number | null };
  currency: string;
}

type ModePrice = { amount_minor: string; currency: string; interval: string };

/** Cheapest current starting price for one delivery mode across the live catalog. */
function cheapestPrice(templates: TemplateSummary[], mode: string, intervals: string[]): ModePrice | null {
  let best: ModePrice | null = null;
  for (const tpl of templates) {
    for (const p of tpl.starting_prices) {
      if (p.deployment_mode !== mode || !intervals.includes(p.interval)) continue;
      if (!best || BigInt(p.amount_minor) < BigInt(best.amount_minor)) best = p;
    }
  }
  return best;
}

/**
 * General service-plan comparison (docs/12 §7): the two delivery modes compared by
 * outcome, with prices read from the live catalog — never hard-coded. A mode with
 * no plan on sale says so instead of showing a price.
 */
async function GeneralCompare({ locale }: { locale: Locale }) {
  const t = (k: string, p?: Record<string, string>) => translate(locale, k, p);
  const [list, config] = await Promise.all([
    fetchPublic<TemplateSummary[]>('/templates?limit=100', locale),
    fetchPublic<PublicConfigShape>('/config/public', locale),
  ]);
  const templates = list.ok ? list.data : [];
  const selfPrice = cheapestPrice(templates, 'selfhost', ['one_time']);
  const hostPrice = cheapestPrice(templates, 'hosted', ['monthly', 'yearly']);
  const storagePerGb = config.ok ? config.data.hosting_storage?.per_gb_minor ?? null : null;
  const hostRateText = typeof storagePerGb === 'number' && storagePerGb > 0 && list.ok
    ? `${formatMoney({ amount_minor: String(storagePerGb), currency: config.ok ? config.data.currency : 'VND' }, locale)}/GB/${t('ui.price.per_monthly')}`
    : null;
  const priceText = (price: ModePrice | null, recurring: boolean): string => {
    // A failed catalog read is not "not on sale": show a neutral dash instead of a claim.
    if (!list.ok) return '—';
    if (!price) return t('ui.plans.not_selling');
    const money = formatMoney(price, locale);
    return recurring ? `${money}/${t(`ui.price.per_${price.interval}`)}` : money;
  };
  const fee = config.ok ? config.data.subdomain_fee : null;
  const feeText = fee && fee.amount_minor !== null
    ? t('ui.setup.subdomain_fee', {
        fee: formatMoney({ amount_minor: String(fee.amount_minor), currency: config.ok ? config.data.currency : 'VND' }, locale),
        period: fee.period === 'monthly' ? t('ui.setup.fee_monthly') : t('ui.setup.fee_once'),
      })
    : t('ui.plans.subdomain_fee_unset');
  const rows: { label: string; hosted: string; selfhost: string }[] = [
    { label: t('ui.plans.row_who'), hosted: t('ui.plans.hosted_who'), selfhost: t('ui.plans.selfhost_who') },
    { label: t('ui.plans.row_operate'), hosted: t('ui.plans.hosted_operate'), selfhost: t('ui.plans.selfhost_operate') },
    { label: t('ui.plans.row_edit'), hosted: t('ui.plans.hosted_edit'), selfhost: t('ui.plans.selfhost_edit') },
    { label: t('ui.plans.row_source'), hosted: t('ui.plans.hosted_source'), selfhost: t('ui.plans.selfhost_source') },
    { label: t('ui.plans.row_subdomain'), hosted: `${t('ui.plans.hosted_subdomain')} ${feeText}`, selfhost: t('ui.plans.selfhost_subdomain') },
    { label: t('ui.plans.row_domain'), hosted: t('ui.plans.hosted_domain'), selfhost: t('ui.plans.selfhost_domain') },
    { label: t('ui.compare.price'), hosted: hostRateText ?? priceText(hostPrice, true), selfhost: priceText(selfPrice, false) },
    { label: t('ui.plans.row_expiry'), hosted: t('ui.plans.hosted_expiry'), selfhost: t('ui.plans.selfhost_expiry') },
    { label: t('ui.plans.row_support'), hosted: t('ui.plans.support_value'), selfhost: t('ui.plans.support_value') },
  ];
  const cards = [
    {
      mode: 'hosted',
      title: t('ui.plans.hosted_title'),
      tagline: t('ui.plans.hosted_for'),
      price: !list.ok ? null : hostRateText ? t('ui.plans.price_from', { price: hostRateText }) : hostPrice ? t('ui.plans.price_from', { price: priceText(hostPrice, true) }) : t('ui.plans.not_selling'),
      cta: list.ok && (hostPrice || hostRateText) ? { href: `/${locale}/templates?mode=hosted`, label: t('ui.plans.cta_hosted') } : null,
    },
    {
      mode: 'selfhost',
      title: t('ui.plans.selfhost_title'),
      tagline: t('ui.plans.selfhost_for'),
      price: !list.ok ? null : selfPrice ? t('ui.plans.price_from', { price: priceText(selfPrice, false) }) : t('ui.plans.not_selling'),
      cta: list.ok && selfPrice ? { href: `/${locale}/templates?mode=selfhost`, label: t('ui.plans.cta_selfhost') } : null,
    },
  ];
  return (
    <div className="container stack">
      <h1>{t('ui.plans.title')}</h1>
      <p className="muted" style={{ maxWidth: 760 }}>{t('ui.plans.intro')}</p>
      {!list.ok ? (
        <div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div>
      ) : null}
      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        {cards.map((card) => (
          <article className="card stack" key={card.mode}>
            <h2 style={{ margin: 0 }}>{card.title}</h2>
            <p style={{ margin: 0 }}>{card.tagline}</p>
            {card.price ? <p style={{ margin: 0 }}><strong>{card.price}</strong></p> : null}
            {card.cta ? <div><Link className="button" href={card.cta.href}>{card.cta.label}</Link></div> : null}
          </article>
        ))}
      </div>
      <h2>{t('ui.plans.table_title')}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('ui.compare.attribute')}</th>
              <th scope="col">{t('ui.plans.hosted_title')}</th>
              <th scope="col">{t('ui.plans.selfhost_title')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.hosted}</td>
                <td>{row.selfhost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{t('ui.plans.detail_note')}</p>
    </div>
  );
}

export default async function ComparePage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { template: slug } = await searchParams;
  if (slug) return <TemplateCompare locale={locale} slug={slug} />;
  return <GeneralCompare locale={locale} />;
}
