'use client';

import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { useCompare } from '@/lib/compare';

/** CAT-09: when the compare page is opened without a selection in the URL,
 *  offer the selection the visitor already made on the catalog/saved list. */
export function CompareStoredLink({ locale }: { locale: Locale }) {
  const t = (key: string) => translate(locale, key);
  const { slugs } = useCompare();
  if (slugs.length < 2) return null;
  return (
    <p>
      <Link className="button" href={`/${locale}/templates/compare?slugs=${encodeURIComponent(slugs.join(','))}`}>
        {t('ui.compare.compare_now')} ({slugs.length})
      </Link>
    </p>
  );
}
