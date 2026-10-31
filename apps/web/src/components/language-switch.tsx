'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { LOCALES, type Locale } from '@3t/i18n';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * "Tiếng Việt / English" switch (docs/05 §2: names, not flags). Public URLs swap the locale
 * prefix so the same resource stays open; dashboards keep their route and only change the UI.
 * The cookie is a preference, never an authorisation signal. A full navigation is used because the
 * root layout (html lang, locale context) persists across client-side transitions.
 */
export function LanguageSwitch() {
  const { t, locale } = useT();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  /* Touch has no hover-leave: close on an outside tap while open. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open ]);

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 250);
  };
  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };

  async function choose(next: Locale) {
    if (next === locale) return;
    document.cookie = `mp_locale=${next}; path=/; max-age=31536000; samesite=lax`;
    // Signed-in users keep the choice as their profile preference (emails, API messages).
    const me = await api<{ locale: Locale }>('/me');
    if (me.ok && me.data.locale !== next) await api('/me', { method: 'PATCH', body: { locale: next }, ifMatch: me.etag });
    const segments = pathname.split('/');
    if (segments[1] === 'vi' || segments[1] === 'en') segments[1] = next;
    window.location.assign(`${segments.join('/')}${window.location.search}`);
  }

  return (
    <span
      ref={rootRef}
      className={`lang-menu${open ? ' lang-menu--open' : ''}`}
      onPointerEnter={(e) => {
        /* Mouse-only hover-open: on touch the synthetic enter fires
         * right before the tap's click and would undo the toggle. */
        if (e.pointerType === 'mouse') openNow();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') scheduleClose();
      }}
    >
      <button
        type="button"
        className="lang-menu__button"
        aria-expanded={open}
        aria-label={t('ui.language.label')}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      </button>
      <span className="lang-menu__panel">
        <span className="lang-menu__caption">{t('ui.language.label')}</span>
        {LOCALES.filter((l) => l.enabled).map((l) => (
          <button
            key={l.code}
            type="button"
            lang={l.code}
            onClick={() => void choose(l.code)}
            aria-pressed={l.code === locale}
            className={`lang-menu__item${l.code === locale ? ' lang-menu__item--active' : ''}`}
          >
            <span>{l.displayNameNative}</span>
            {l.code === locale ? (
              <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : null}
          </button>
        ))}
      </span>
    </span>
  );
}
