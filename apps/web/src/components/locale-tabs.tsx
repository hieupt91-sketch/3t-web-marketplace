'use client';

import { useState, type ReactNode } from 'react';
import { LOCALES, type Locale } from '@3t/i18n';
import { useT } from '@/lib/i18n';
import { StatusBadge } from './ui';

export type LocaleStatus = 'published' | 'reviewed' | 'draft' | 'missing' | 'stale';

/** LocaleTabs (docs/05 §3): shows per-locale status; dirty state is owned by each child. */
export function LocaleTabs({ statusFor, render }: { statusFor: (locale: Locale) => LocaleStatus; render: (locale: Locale) => ReactNode }) {
  const { t } = useT();
  const [active, setActive] = useState<Locale>('vi');
  const tone = (s: LocaleStatus) => (s === 'published' ? 'success' : s === 'missing' ? 'error' : s === 'stale' ? 'warning' : 'neutral');
  return (
    <div className="stack">
      <div role="tablist" aria-label={t('ui.locale_tabs.label')} className="row">
        {LOCALES.filter((l) => l.enabled).map((l) => {
          const status = statusFor(l.code);
          return (
            <button
              key={l.code}
              role="tab"
              type="button"
              aria-selected={active === l.code}
              className={`button ${active === l.code ? '' : 'button--secondary'}`}
              onClick={() => setActive(l.code)}
            >
              {l.displayNameNative} <StatusBadge tone={tone(status)}>{t(`ui.locale_status.${status}`)}</StatusBadge>
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{render(active)}</div>
    </div>
  );
}
