'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { formatDateTime, translate, type Locale } from '@3t/i18n';

const LocaleContext = createContext<Locale>('vi');

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** Translation hook; values are rendered as text by React, never as HTML. */
export function useT() {
  const locale = useLocale();
  const t = useCallback((key: string, params?: Record<string, string | number>) => translate(locale, key, params), [locale]);
  const dt = useCallback((iso: string | null | undefined) => (iso ? formatDateTime(iso, locale) : '—'), [locale]);
  return { t, dt, locale };
}
