'use client';

import { translate, type Locale } from '@3t/i18n';
import { toggleSaved, useSaved } from '@/lib/saved';

/** CAT-08 save toggle: bookmark state for one template. Works for guests
 *  (browser-local list) and signed-in customers (server list) through the
 *  shared store in lib/saved.ts. */
export function SaveButton({ templateId, locale, iconOnly = false }: { templateId: string; locale: Locale; iconOnly?: boolean }) {
  const t = (key: string) => translate(locale, key);
  const saved = useSaved();
  const isSaved = saved.ids.has(templateId);
  if (iconOnly) {
    return (
      <button
        type="button"
        className="button button--secondary save-button--icon"
        aria-pressed={isSaved}
        aria-label={isSaved ? t('ui.saved.saved') : t('ui.saved.save')}
        title={isSaved ? t('ui.saved.saved') : t('ui.saved.save')}
        onClick={() => void toggleSaved(templateId)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="button button--secondary"
      aria-pressed={isSaved}
      aria-label={isSaved ? t('ui.saved.saved') : t('ui.saved.save')}
      onClick={() => void toggleSaved(templateId)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 6 }}>
        <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      {isSaved ? t('ui.saved.saved') : t('ui.saved.save')}
    </button>
  );
}
