'use client';

import { useState } from 'react';
import { translate, type Locale } from '@3t/i18n';
import { COMPARE_MAX, toggleCompare, useCompare } from '@/lib/compare';

/** CAT-09 compare toggle on a template card (max three templates). */
export function CompareToggle({ slug, locale }: { slug: string; locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  const { slugs } = useCompare();
  const [full, setFull] = useState(false);
  const selected = slugs.includes(slug);
  return (
    <span>
      <button
        type="button"
        className="button button--secondary"
        aria-pressed={selected}
        onClick={() => {
          const applied = toggleCompare(slug);
          setFull(!applied);
        }}
      >
        {selected ? t('ui.compare.selected_toggle') : t('ui.compare.select')}
      </button>
      {full && !selected ? <span className="muted" role="status"> {t('ui.compare.max_reached', { max: String(COMPARE_MAX) })}</span> : null}
    </span>
  );
}
