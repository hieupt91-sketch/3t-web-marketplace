import type { Metadata } from 'next';
import Link from 'next/link';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import { fetchPublic, type PublicPlan, type TemplateSummary } from '@/lib/api-server';
import { isDynamicAdapter } from '@/lib/template-kind';
import { CompareStoredLink } from '@/components/compare-stored-link';
import { coverGradient } from '@/lib/cover-gradient';

type Detail = TemplateSummary & { plans: PublicPlan[] };
type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ slugs?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: translate(locale, 'ui.compare.templates_title'), robots: { index: false, follow: true } };
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function minPrice(plans: PublicPlan[], interval: 'one_time' | 'monthly' | 'yearly'): { amount_minor: string; currency: string } | null {
  let best: { amount_minor: string; currency: string } | null = null;
  for (const plan of plans) {
    for (const price of plan.prices) {
      if (price.interval !== interval) continue;
      if (!best || BigInt(price.amount_minor) < BigInt(best.amount_minor)) best = price;
    }
  }
  return best;
}

/**
 * CAT-09 — template comparison on one criteria table (docs/12 §4): who it
 * suits, how content is edited, whether the form really receives, admin
 * panel, content languages, delivery modes actually on sale, up-front and
 * recurring prices from live plans. Nothing is inferred from artwork:
 * modes and prices come from plans on sale, capabilities from the
 * version manifest.
 */
export default async function CompareTemplatesPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { slugs: rawSlugs = '' } = await searchParams;
  const t = (key: string, p?: Record<string, string>) => translate(locale, key, p);
  const slugs = [...new Set(rawSlugs.split(',').map((s) => s.trim()).filter((s) => SLUG_RE.test(s)))].slice(0, 3);
  const fetched = await Promise.all(
    slugs.map(async (slug) => {
      const res = await fetchPublic<Detail>(`/templates/${encodeURIComponent(slug)}`, locale);
      return res.ok ? res.data : null;
    }),
  );
  const templates = fetched.filter((d): d is Detail => d !== null);

  if (templates.length < 2) {
    return (
      <div className="container stack">
        <h1>{t('ui.compare.templates_title')}</h1>
        <p>{t('ui.compare.need_two')}</p>
        <CompareStoredLink locale={locale} />
        <p><Link className="button button--secondary" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link></p>
      </div>
    );
  }

  const hasAdmin = (d: Detail) => d.capabilities.includes('admin');
  const rows: { label: string; values: (d: Detail) => string }[] = [
    { label: t('ui.catalog.filter_kind'), values: (d) => (isDynamicAdapter(d.adapter) ? t('ui.catalog.kind_dynamic') : t('ui.catalog.kind_static')) },
    { label: t('ui.compare.audience'), values: (d) => (d.category ? t(`ui.category.${d.category}`) : '—') },
    { label: t('ui.compare.edit'), values: (d) => (hasAdmin(d) ? t('ui.compare.edit_admin') : t('ui.compare.edit_files')) },
    { label: t('ui.compare.form'), values: (d) => (hasAdmin(d) ? t('ui.compare.form_received') : t('ui.compare.form_display')) },
    { label: t('ui.compare.admin'), values: (d) => (hasAdmin(d) ? t('ui.compare.yes') : t('ui.compare.no')) },
    { label: t('ui.compare.languages'), values: (d) => d.content_locales.map((l) => l.toUpperCase()).join(', ') || '—' },
    {
      label: t('ui.compare.delivery'),
      values: (d) => {
        const modes = [...new Set(d.plans.map((p) => p.deployment_mode))];
        return modes.length > 0 ? modes.map((m) => t(`ui.deployment.${m}`)).join(' · ') : t('ui.compare.not_on_sale');
      },
    },
    {
      label: t('ui.compare.price_initial'),
      values: (d) => {
        const price = minPrice(d.plans, 'one_time');
        return price ? formatMoney(price, locale) : '—';
      },
    },
    {
      label: t('ui.compare.price_recurring'),
      values: (d) => {
        const monthly = minPrice(d.plans, 'monthly');
        if (monthly) return `${formatMoney(monthly, locale)}${t('ui.compare.per_month')}`;
        const yearly = minPrice(d.plans, 'yearly');
        if (yearly) return `${formatMoney(yearly, locale)}${t('ui.compare.per_year')}`;
        return '—';
      },
    },
  ];

  const removeHref = (slug: string) => {
    const rest = templates.filter((d) => d.slug !== slug).map((d) => d.slug);
    return rest.length >= 2 ? `/${locale}/templates/compare?slugs=${encodeURIComponent(rest.join(','))}` : `/${locale}/templates`;
  };

  return (
    <div className="container stack">
      <h1>{t('ui.compare.templates_title')}</h1>
      <div className="table-wrap">
        <table className="table compare-table">
          <thead>
            <tr>
              <th scope="col">{t('ui.compare.attribute')}</th>
              {templates.map((d) => (
                <th key={d.id} scope="col">
                  <div className="stack" style={{ gap: 'var(--space-2)' }}>
                    <span className="template-card__image" style={d.preview_image ? undefined : { background: coverGradient(d.slug), border: 'none', minHeight: 80 }}>
                      {d.preview_image ? <img src={d.preview_image} alt="" /> : null}
                    </span>
                    <Link href={`/${locale}/templates/${d.slug}`}>{d.title}</Link>
                    <span>
                      {isDynamicAdapter(d.adapter) ? (
                        <span className="badge badge--info">{t('ui.catalog.badge_dynamic')}</span>
                      ) : (
                        <span className="badge badge--neutral">{t('ui.catalog.kind_static')}</span>
                      )}
                    </span>
                    <span className="row">
                      <Link className="button button--secondary" href={`/${locale}/templates/${d.slug}`}>{t('ui.catalog.view_detail')}</Link>
                      <Link className="button button--secondary" href={removeHref(d.slug)}>{t('ui.compare.remove')}</Link>
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {templates.map((d) => <td key={d.id}>{row.values(d)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
