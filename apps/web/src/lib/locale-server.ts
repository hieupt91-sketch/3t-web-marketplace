import { cookies, headers } from 'next/headers';
import { negotiateLocale, type Locale } from '@3t/i18n';

export const LOCALE_COOKIE = 'mp_locale';

/** Interface locale for the current request: URL prefix (set by middleware) → cookie → Accept-Language → vi. */
export async function requestLocale(): Promise<Locale> {
  const h = await headers();
  const c = await cookies();
  return negotiateLocale({
    explicit: h.get('x-locale'),
    userPreference: c.get(LOCALE_COOKIE)?.value,
    acceptLanguage: h.get('accept-language'),
  });
}
