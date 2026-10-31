'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatMoney, translate, type Locale } from '@3t/i18n';
import type { TemplateSummary } from '@/lib/api-server';
import { coverGradient } from '@/lib/cover-gradient';
import { SaveButton } from '@/components/save-button';
import { CompareToggle } from '@/components/compare-toggle';
import { LiveThumb } from '@/components/live-thumb';
import { isDynamicAdapter } from '@/lib/template-kind';

export function TemplateCard({ template, locale, comparable = false }: { template: TemplateSummary; locale: Locale; comparable?: boolean }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  // If the photo fails to load (republished without a hero photo), fall back
  // to the gradient cover instead of showing a broken image.
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!template.preview_image && !imgFailed;
  // Lowest current price across modes, shown as a "from" figure (docs/05 §13 P02).
  const cheapest = template.starting_prices.reduce<TemplateSummary['starting_prices'][number] | null>(
    (min, p) => (!min || BigInt(p.amount_minor) < BigInt(min.amount_minor) ? p : min),
    null,
  );
  return (
    <article className="card template-card">
      <div className="template-card__image" style={showImg ? undefined : { background: coverGradient(template.slug), border: 'none' }}>
        {showImg ? (
          <img src={template.preview_image!} alt={t('ui.catalog.screenshot_alt', { title: template.title })} onError={() => setImgFailed(true)} />
        ) : (
          <span style={{ color: '#ffffff', fontWeight: 700, fontSize: 18, textAlign: 'center', padding: 'var(--space-4)' }}>{template.title}</span>
        )}
        {template.demo.available && template.demo.url ? <LiveThumb url={template.demo.url} title={template.title} /> : null}
        {isDynamicAdapter(template.adapter) ? (
          <span className="badge badge--info template-card__kind">{t('ui.catalog.badge_dynamic')}</span>
        ) : (
          <span className="badge badge--neutral template-card__kind">{t('ui.catalog.kind_static')}</span>
        )}
        {template.translation_status === 'fallback' ? <span className="badge badge--warning template-card__badge" lang="vi">{t('ui.catalog.fallback_vi')}</span> : null}
        {comparable ? <CompareToggle slug={template.slug} locale={locale} chip /> : null}
      </div>
      <h3 className="template-card__title" style={{ margin: 0 }}>
        <Link href={`/${locale}/templates/${template.slug}`}>{template.title}</Link>
      </h3>
      <p className="template-card__price tabular" style={{ margin: 0 }}>
        {cheapest ? (
          <>
            <span>{t('ui.catalog.price_from')}</span>
            <strong>{formatMoney(cheapest, locale)}</strong>
          </>
        ) : null}
      </p>
      <p className="muted template-card__summary" style={{ margin: 0 }} aria-hidden={template.summary ? undefined : true}>
        {template.summary ?? ''}
      </p>
      <p className="muted template-card__meta" style={{ margin: 0 }}>
        {t('ui.catalog.content_locales', { locales: template.content_locales.join(', ').toUpperCase() })}
      </p>
      <div className="row template-card__actions" style={{ marginTop: 'auto' }}>
        <SaveButton templateId={template.id} locale={locale} iconOnly />
        {template.demo.available ? <Link className="button button--secondary" href={`/${locale}/demo/${template.slug}`}>{t('ui.catalog.view_demo')}</Link> : null}
        <Link className="button" href={`/${locale}/templates/${template.slug}`}>{t('ui.catalog.view_detail')}</Link>
      </div>
    </article>
  );
}
