'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { useMe, type Me } from '@/lib/use-me';
import { ErrorState, Loading } from './ui';
import { SiteHeader } from './site-header';

const MeContext = createContext<Me | null>(null);

export function useCurrentUser(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useCurrentUser outside DashboardShell');
  return me;
}

interface NavItem {
  href: string;
  labelKey: string;
  permission?: string;
}

const NAV: Record<'account' | 'admin', NavItem[]> = {
  account: [
    { href: '/account', labelKey: 'ui.account.nav.overview' },
    { href: '/account/purchases', labelKey: 'ui.account.nav.purchases' },
    { href: '/account/security', labelKey: 'ui.account.nav.security' },
  ],
  admin: [
    { href: '/admin', labelKey: 'ui.admin.nav.overview', permission: 'report:read' },
    { href: '/admin/templates', labelKey: 'ui.admin.nav.templates', permission: 'template:read' },
    { href: '/admin/imports', labelKey: 'ui.admin.nav.imports', permission: 'template:read' },
    { href: '/admin/imports/new', labelKey: 'ui.admin.nav.import_new', permission: 'template:import' },
    { href: '/admin/content', labelKey: 'ui.admin.nav.content', permission: 'content:read' },
  ],
};

/**
 * Authenticated area shell. Hiding nav items is a convenience only — every API call is
 * authorised server-side (docs/11 §4).
 */
export function DashboardShell({ area, children }: { area: 'account' | 'admin'; children: ReactNode }) {
  const { t } = useT();
  const state = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  useEffect(() => {
    if (state.status === 'anonymous') {
      const next = encodeURIComponent(pathname + window.location.search);
      router.replace(`/auth/login?next=${next}${state.expired ? '&reason=expired' : ''}`);
    }
  }, [state, pathname, router]);

  let body: ReactNode;
  if (state.status === 'loading' || state.status === 'anonymous') body = <Loading />;
  else if (state.status === 'error') body = <ErrorState error={state.error} />;
  else {
    const items = NAV[area].filter((item) => !item.permission || state.me.permissions.includes(item.permission));
    const allowed = area === 'account' || items.length > 0;
    body = (
      <div className="dashboard">
        <nav className="dashboard__nav" aria-label={t(area === 'admin' ? 'ui.admin.nav.label' : 'ui.account.nav.label')}>
          <ul>
            {items.map((item) => (
              <li key={item.href}>
                <Link href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="dashboard__main" tabIndex={-1}>
          {allowed ? (
            <MeContext.Provider value={state.me}>{children}</MeContext.Provider>
          ) : (
            <ErrorState error={{ code: 'auth.forbidden', message: t('error.auth.forbidden'), field_errors: [], request_id: null, retryable: false }} />
          )}
        </main>
      </div>
    );
  }
  return (
    <>
      <SiteHeader />
      {body}
    </>
  );
}

/** Inline permission gate for a page section; the API still enforces the same rule. */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const me = useCurrentUser();
  const { t } = useT();
  if (!me.permissions.includes(permission)) {
    return <ErrorState error={{ code: 'auth.forbidden', message: t('error.auth.forbidden'), field_errors: [], request_id: null, retryable: false }} />;
  }
  return <>{children}</>;
}
