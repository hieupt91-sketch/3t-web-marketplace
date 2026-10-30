'use client';

import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { clearCompare, useCompare } from '@/lib/compare';

/** CAT-09 compare tray: appears once at least one template is selected,
 *  links to the dedicated compare page with the selection in the URL. */
export function CompareTray({ locale }: { locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  const { slugs } = useCompare();
  if (slugs.length === 0) return null;
  const href = `/${locale}/templates/compare?slugs=${encodeURIComponent(slugs.join(','))}`;
  return (
    <div className="compare-tray" role="region" aria-label={t('ui.compare.templates_title')}>
      <span>{t('ui.compare.selected_count', { count: String(slugs.length), max: '3' })}</span>
      {slugs.length >= 2 ? (
        <Link className="button" href={href}>{t('ui.compare.compare_now')}</Link>
      ) : (
        <span className="muted">{t('ui.compare.need_two')}</span>
      )}
      <button type="button" className="button button--secondary" onClick={() => clearCompare()}>{t('ui.compare.clear')}</button>
    </div>
  );
}
