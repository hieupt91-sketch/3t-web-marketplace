'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

const NAV: Record<'account' | 'partner', NavItem[]> = {
  account: [
    { href: '/account', labelKey: 'ui.account.nav.overview' },
    { href: '/account/purchases', labelKey: 'ui.account.nav.purchases' },
    { href: '/account/orders', labelKey: 'ui.account.nav.orders' },
    { href: '/account/saved', labelKey: 'ui.account.nav.saved' },
    { href: '/account/sites', labelKey: 'ui.account.nav.sites' },
    { href: '/account/support', labelKey: 'ui.account.nav.support' },
    { href: '/account/settings', labelKey: 'ui.account.nav.settings' },
    { href: '/account/security', labelKey: 'ui.account.nav.security' },
  ],
  partner: [
    { href: '/partner', labelKey: 'ui.partner.title' },
    { href: '/partner/apply', labelKey: 'ui.partner.apply' },
    { href: '/partner/catalog', labelKey: 'ui.partner.catalog' },
    { href: '/partner/links', labelKey: 'ui.partner.links' },
    { href: '/partner/orders', labelKey: 'ui.partner.orders' },
    { href: '/partner/commissions', labelKey: 'ui.partner.commissions' },
    { href: '/partner/payouts', labelKey: 'ui.partner.payouts' },
    { href: '/partner/api-keys', labelKey: 'ui.partner.api_keys' },
    { href: '/partner/webhooks', labelKey: 'ui.partner.webhooks' },
    { href: '/partner/developers', labelKey: 'ui.partner.developers' },
    { href: '/partner/settings', labelKey: 'ui.partner.settings' },
  ],
};

/** The admin menu is split into collapsible main menus by function —
 *  overview → goods → content → payments → operations → system →
 *  settings — so the sidebar stays short: only expanded groups show
 *  their sub-items. A group renders only when the staffer can see at
 *  least one item. */
const ADMIN_NAV: NavGroup[] = [
  {
    labelKey: 'ui.admin.nav.group_overview',
    items: [
      { href: '/admin', labelKey: 'ui.admin.nav.overview', permission: 'report:read' },
      { href: '/admin/stats', labelKey: 'ui.admin.nav.stats', permission: 'report:read' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_goods',
    items: [
      { href: '/admin/templates', labelKey: 'ui.admin.nav.templates', permission: 'template:read' },
      { href: '/admin/imports', labelKey: 'ui.admin.nav.imports', permission: 'template:read' },
      { href: '/admin/imports/new', labelKey: 'ui.admin.nav.import_new', permission: 'template:import' },
      { href: '/admin/pricing', labelKey: 'ui.admin.nav.pricing', permission: 'pricing:write' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_content',
    items: [
      { href: '/admin/content', labelKey: 'ui.admin.nav.content', permission: 'content:read' },
      { href: '/admin/translations', labelKey: 'ui.admin.translations', permission: 'template:read' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_payments',
    items: [
      { href: '/admin/payments/reconciliation', labelKey: 'ui.admin.nav.reconciliation', permission: 'payment:read' },
      { href: '/admin/payments/refunds', labelKey: 'ui.admin.nav.refunds', permission: 'payment:read' },
      { href: '/admin/payouts', labelKey: 'ui.admin.payouts', permission: 'payout:read' },
      { href: '/admin/settings/payments/bank', labelKey: 'ui.checkout.method_bank', permission: 'settings:manage' },
      { href: '/admin/settings/payments/vnpay', labelKey: 'ui.checkout.method_vnpay', permission: 'settings:manage' },
      { href: '/admin/settings/payments/momo', labelKey: 'ui.checkout.method_momo', permission: 'settings:manage' },
      { href: '/admin/settings/payments/paypal', labelKey: 'ui.checkout.method_paypal', permission: 'settings:manage' },
      { href: '/admin/settings/payments/usd', labelKey: 'ui.checkout.method_usd', permission: 'settings:manage' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_operations',
    items: [
      { href: '/admin/sites', labelKey: 'ui.admin.nav.sites', permission: 'site:operate' },
      { href: '/admin/domains', labelKey: 'ui.admin.nav.domains', permission: 'site:operate' },
      { href: '/admin/demos', labelKey: 'ui.admin.nav.demos', permission: 'ops:read' },
      { href: '/admin/jobs', labelKey: 'ui.admin.nav.jobs', permission: 'ops:read' },
      { href: '/admin/service-tasks', labelKey: 'ui.admin.nav.service_tasks', permission: 'ops:read' },
      { href: '/admin/backups', labelKey: 'ui.admin.nav.backups', permission: 'site:operate' },
      { href: '/admin/support', labelKey: 'ui.admin.nav.support', permission: 'support:read' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_system',
    items: [
      { href: '/admin/partners', labelKey: 'ui.admin.partners', permission: 'partner:read' },
      { href: '/admin/staff', labelKey: 'ui.admin.staff', permission: 'staff:manage' },
    ],
  },
  {
    labelKey: 'ui.admin.nav.group_settings',
    items: [
      { href: '/admin/settings', labelKey: 'ui.admin.nav.settings_hub', permission: 'settings:manage' },
      { href: '/admin/settings/contact', labelKey: 'ui.admin.nav.contact_settings', permission: 'settings:manage' },
      { href: '/admin/settings/subdomain-fee', labelKey: 'ui.admin.nav.subdomain_fee_settings', permission: 'settings:manage' },
      { href: '/admin/settings/installation-service', labelKey: 'ui.admin.nav.installation_service', permission: 'settings:manage' },
      { href: '/admin/settings/ads', labelKey: 'ui.admin.nav.ads_settings', permission: 'settings:manage' },
    ],
  },
];

/**
 * Authenticated area shell. Hiding nav items is a convenience only — every API call is
 * authorised server-side (docs/11 §4).
 */
export function DashboardShell({ area, children }: { area: 'account' | 'admin' | 'partner'; children: ReactNode }) {
  const { t } = useT();
  const state = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  /* Collapsible admin main menus: which groups are expanded, persisted
   * per browser. The group holding the current page opens on its own;
   * a group the staffer closed by hand stays closed until they move
   * to a page inside another group. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [navLoaded, setNavLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('mp_admin_nav_open');
      if (raw) setOpenGroups(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* storage unavailable: defaults apply */
    }
    setNavLoaded(true);
  }, []);
  const activeAdminGroup = ADMIN_NAV.find((g) =>
    g.items.some((i) => pathname === i.href || (i.href !== '/admin' && pathname.startsWith(`${i.href}/`))),
  )?.labelKey;
  useEffect(() => {
    if (!navLoaded || area !== 'admin' || !activeAdminGroup) return;
    setOpenGroups((prev) => (prev[activeAdminGroup] ? prev : { ...prev, [activeAdminGroup]: true }));
  }, [navLoaded, area, activeAdminGroup]);
  const toggleGroup = (key: string, currentlyOpen: boolean) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [key]: !currentlyOpen };
      try {
        window.localStorage.setItem('mp_admin_nav_open', JSON.stringify(next));
      } catch {
        /* storage unavailable: the toggle still applies for this view */
      }
      return next;
    });
  };

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
    const can = (item: NavItem) => !item.permission || state.me.permissions.includes(item.permission);
    const flatItems = area === 'admin' ? [] : NAV[area].filter(can);
    const groups = area === 'admin'
      ? ADMIN_NAV.map((g) => ({ ...g, items: g.items.filter(can) })).filter((g) => g.items.length > 0)
      : [];
    const visibleCount = area === 'admin' ? groups.reduce((a, g) => a + g.items.length, 0) : flatItems.length;
    const allowed = area === 'account' || visibleCount > 0;
    const link = (item: NavItem) => (
      <li key={item.href}>
        <Link href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
          {t(item.labelKey)}
        </Link>
      </li>
    );
    body = (
      <div className="dashboard">
        <nav className="dashboard__nav" aria-label={t(area === 'admin' ? 'ui.admin.nav.label' : 'ui.account.nav.label')}>
          {area === 'admin' ? (
            groups.map((g) => {
              const open = openGroups[g.labelKey] ?? g.labelKey === activeAdminGroup;
              return (
                <div key={g.labelKey} className="dashboard__nav-group">
                  <button
                    type="button"
                    className="dashboard__nav-heading"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.labelKey, open)}
                  >
                    <span>{t(g.labelKey)}</span>
                    <svg
                      className={`dashboard__nav-chevron${open ? ' dashboard__nav-chevron--open' : ''}`}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {open ? <ul>{g.items.map(link)}</ul> : null}
                </div>
              );
            })
          ) : (
            <ul>{flatItems.map(link)}</ul>
          )}
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
