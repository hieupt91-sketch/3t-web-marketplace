import { NextResponse, type NextRequest } from 'next/server';
import { negotiateLocale } from '@3t/i18n';

const PUBLIC_LOCALES = new Set(['vi', 'en']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function middleware(request: NextRequest) {
  // The portal only exists over HTTPS: the API enforces an exact-match https
  // Origin on every mutation (apps/api checkOrigin). The edge forwards
  // plain-HTTP visits to the origin instead of upgrading them, so a visitor
  // who lands on http://webmaket.com gets a fully rendered page whose every
  // POST is then rejected as security.origin_mismatch (owner report
  // 2026-10-30, POST /api/v1/demo-sessions from an http page). Upgrade any
  // proxied HTTP page load to HTTPS before anything else runs. The matcher
  // excludes api/ paths, so in-flight API calls keep their precise errors
  // and the API check itself stays strict — http origins are never blessed.
  // Host and scheme come from the forwarded headers, NOT request.nextUrl:
  // under `next start` nextUrl is the internal http://localhost URL (verified
  // by local simulation 2026-10-30), while the edge's x-forwarded-proto and
  // the Host header reach middleware intact.
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const authority = (request.headers.get('host') ?? request.headers.get('x-forwarded-host'))?.split(',')[0]?.trim();
  if (forwardedProto === 'http' && authority) {
    const hostname = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0];
    if (hostname && !LOCAL_HOSTS.has(hostname.toLowerCase())) {
      const { pathname, search } = request.nextUrl;
      return NextResponse.redirect(`https://${authority}${pathname}${search}`, 308);
    }
  }
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
