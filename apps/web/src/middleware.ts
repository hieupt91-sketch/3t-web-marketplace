import { NextResponse, type NextRequest } from 'next/server';
import { negotiateLocale } from '@3t/i18n';

const PUBLIC_LOCALES = new Set(['vi', 'en']);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split('/')[1] ?? '';
  const preferred = negotiateLocale({
    userPreference: request.cookies.get('mp_locale')?.value,
    acceptLanguage: request.headers.get('accept-language'),
  });
  if (pathname === '/') {
    // Public URLs always carry a locale; no IP-based redirect loops (docs/07 §3).
    return NextResponse.redirect(new URL(`/${preferred}`, request.url));
  }
  const headers = new Headers(request.headers);
  headers.set('x-locale', PUBLIC_LOCALES.has(first) ? first : preferred);
  headers.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico|robots.txt).*)'],
};
