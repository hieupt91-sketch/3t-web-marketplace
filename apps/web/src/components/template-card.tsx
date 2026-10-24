import Link from 'next/link';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import type { TemplateSummary } from '@/lib/api-server';

export function TemplateCard({ template, locale }: { template: TemplateSummary; locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  // Lowest current price across modes, shown as a "from" figure (docs/05 §13 P02).
  const cheapest = template.starting_prices.reduce<TemplateSummary['starting_prices'][number] | null>(
    (min, p) => (!min || BigInt(p.amount_minor) < BigInt(min.amount_minor) ? p : min),
    null,
  );
  return (
    <article className="card template-card">
      <div className="template-card__image">
        {template.preview_image ? <img src={template.preview_image} alt={t('ui.catalog.screenshot_alt', { title: template.title })} /> : <span>{t('ui.catalog.no_image')}</span>}
      </div>
      <h3 style={{ margin: 0 }}>
        <Link href={`/${locale}/templates/${template.slug}`}>{template.title}</Link>
      </h3>
      {template.summary ? <p className="muted" style={{ margin: 0 }}>{template.summary}</p> : null}
      {cheapest ? (
        <p style={{ margin: 0 }} className="tabular">
          {t('ui.catalog.price_from')} <strong>{formatMoney(cheapest, locale)}</strong>
        </p>
      ) : null}
      <p style={{ margin: 0 }} className="muted">
        {t('ui.catalog.content_locales', { locales: template.content_locales.join(', ').toUpperCase() })}
      </p>
      {template.translation_status === 'fallback' ? <p className="badge badge--warning" lang="vi">{t('ui.catalog.fallback_vi')}</p> : null}
      <div className="row">
        {template.demo.available ? <Link className="button button--secondary" href={`/${locale}/demo/${template.slug}`}>{t('ui.catalog.view_demo')}</Link> : null}
        <Link className="button" href={`/${locale}/templates/${template.slug}`}>{t('ui.catalog.view_detail')}</Link>
      </div>
    </article>
  );
}
