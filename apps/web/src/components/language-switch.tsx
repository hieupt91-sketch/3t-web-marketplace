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
    <div role="group" aria-label={t('ui.language.label')} className="row" style={{ gap: 4 }}>
      {LOCALES.filter((l) => l.enabled).map((l, index) => (
        <span key={l.code} className="row" style={{ gap: 4 }}>
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          <button
            type="button"
            lang={l.code}
            onClick={() => void choose(l.code)}
            aria-pressed={l.code === locale}
            style={{
              background: 'none',
              border: 0,
              padding: '0 4px',
              minHeight: 44,
              font: 'inherit',
              cursor: 'pointer',
              color: l.code === locale ? 'var(--color-text)' : 'var(--color-primary)',
              fontWeight: l.code === locale ? 700 : 400,
              textDecoration: l.code === locale ? 'none' : 'underline',
            }}
          >
            {l.displayNameNative}
          </button>
        </span>
      ))}
    </div>
  );
}
