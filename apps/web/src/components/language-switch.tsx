'use client';

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
    <div role="group" aria-label={t('ui.language.label')} className="lang-switch">
      <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lang-switch__globe">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      {LOCALES.filter((l) => l.enabled).map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          onClick={() => void choose(l.code)}
          aria-pressed={l.code === locale}
          className={`lang-switch__option${l.code === locale ? ' lang-switch__option--active' : ''}`}
        >
          {l.code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
