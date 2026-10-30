'use client';

import { useState } from 'react';
import { translate, type Locale } from '@3t/i18n';
import { COMPARE_MAX, toggleCompare, useCompare } from '@/lib/compare';

/** CAT-09 compare toggle on a template card (max three templates).
 *  `chip` renders it as a small overlay pill for the card's cover image,
 *  keeping the card's single action row free for the buy-flow buttons. */
export function CompareToggle({ slug, locale, chip = false }: { slug: string; locale: Locale; chip?: boolean }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  const { slugs } = useCompare();
  const [full, setFull] = useState(false);
  const selected = slugs.includes(slug);
  if (chip) {
    return (
      <span className="compare-chip-wrap">
        <button
          type="button"
          className="compare-chip"
          aria-pressed={selected}
          onClick={() => {
            const applied = toggleCompare(slug);
            setFull(!applied);
          }}
        >
          {selected ? t('ui.compare.selected_toggle') : t('ui.compare.select')}
        </button>
        {full && !selected ? <span className="compare-chip__note" role="status">{t('ui.compare.max_reached', { max: String(COMPARE_MAX) })}</span> : null}
      </span>
    );
  }
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
