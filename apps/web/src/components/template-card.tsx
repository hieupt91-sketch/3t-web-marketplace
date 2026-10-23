import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import type { TemplateSummary } from '@/lib/api-server';

export function TemplateCard({ template, locale }: { template: TemplateSummary; locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  return (
    <article className="card template-card">
      <div className="template-card__image">
        {template.preview_image ? <img src={template.preview_image} alt={t('ui.catalog.screenshot_alt', { title: template.title })} /> : <span>{t('ui.catalog.no_image')}</span>}
      </div>
      <h3 style={{ margin: 0 }}>
        <Link href={`/${locale}/templates/${template.slug}`}>{template.title}</Link>
      </h3>
      {template.summary ? <p className="muted" style={{ margin: 0 }}>{template.summary}</p> : null}
      <p style={{ margin: 0 }} className="muted">
        {t('ui.catalog.content_locales', { locales: template.content_locales.join(', ').toUpperCase() })}
      </p>
      {template.translation_status === 'fallback' ? <p className="badge badge--warning" lang="vi">{t('ui.catalog.fallback_vi')}</p> : null}
    </article>
  );
}
