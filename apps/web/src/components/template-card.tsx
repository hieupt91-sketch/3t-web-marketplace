import Link from 'next/link';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import type { TemplateSummary } from '@/lib/api-server';

/** Deterministic decorative gradient per template (no fake screenshot): the colour
 *  comes from the slug, so the same template always gets the same cover. */
const COVER_GRADIENTS = [
  'linear-gradient(135deg, #1d4ed8, #7c3aed)',
  'linear-gradient(135deg, #0891b2, #1d4ed8)',
  'linear-gradient(135deg, #db2777, #7c3aed)',
  'linear-gradient(135deg, #059669, #0891b2)',
  'linear-gradient(135deg, #ea580c, #db2777)',
  'linear-gradient(135deg, #6d28d9, #0891b2)',
];

export function coverGradient(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length]!;
}

export function TemplateCard({ template, locale }: { template: TemplateSummary; locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  // Lowest current price across modes, shown as a "from" figure (docs/05 §13 P02).
  const cheapest = template.starting_prices.reduce<TemplateSummary['starting_prices'][number] | null>(
    (min, p) => (!min || BigInt(p.amount_minor) < BigInt(min.amount_minor) ? p : min),
    null,
  );
  return (
    <article className="card template-card">
      <div className="template-card__image" style={template.preview_image ? undefined : { background: coverGradient(template.slug), border: 'none' }}>
        {template.preview_image ? (
          <img src={template.preview_image} alt={t('ui.catalog.screenshot_alt', { title: template.title })} />
        ) : (
          <span style={{ color: '#ffffff', fontWeight: 700, fontSize: 18, textAlign: 'center', padding: 'var(--space-4)' }}>{template.title}</span>
        )}
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
