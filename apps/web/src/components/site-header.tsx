'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/use-me';
import { useSaved } from '@/lib/saved';
import { api } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { LanguageSwitch } from './language-switch';

const CATEGORY_ORDER = ['food', 'beauty', 'realestate', 'business', 'store', 'landing', 'portfolio', 'blog', 'website'];

/**
 * One header dropdown, shared by EVERY top-level menu (owner-approved
 * Canva sheet, 2026-11-01): identical panel, caption and plain-text rows
 * everywhere — no icons, no counts. Opens on hover for mouse users; the
 * chevron toggles it for touch, and an outside tap closes it.
 */
export interface NavMenuItem { href: string; label: string }

function NavMenu({ href, label, caption, items, footer }: { href: string; label: string; caption: string; items: NavMenuItem[]; footer?: ReactNode }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  /* Touch has no hover-leave: an outside tap is the only way to close
   * a menu opened by the chevron, so listen for one while open. */
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

  return (
    <span
      ref={rootRef}
      className={`nav-dropdown${open ? ' nav-dropdown--open' : ''}`}
      onPointerEnter={(e) => {
        /* Hover-open only for a real mouse: on touch, the synthetic
         * enter fires right before the tap's click and would instantly
         * undo the chevron's toggle. */
        if (e.pointerType === 'mouse') openNow();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') scheduleClose();
      }}
    >
      <Link href={href}>{label}</Link>
      <button
        type="button"
        className="nav-dropdown__toggle"
        aria-expanded={open}
        aria-label={caption}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <span className="nav-dropdown__panel" role="menu">
        <span className="nav-dropdown__caption" aria-hidden="true">{caption}</span>
        {items.map((item) => (
          <Link key={item.href + item.label} href={item.href} className="nav-dropdown__item" onClick={() => setOpen(false)}>
            <span className="nav-dropdown__label">{item.label}</span>
          </Link>
        ))}
        {footer}
      </span>
    </span>
  );
}

/**
 * "Mẫu website" menu: a plain, single-column list of the live categories
 * (the catalog fetch decides which categories exist; counts are not
 * displayed, per owner taste).
 */
function CategoryMenu({ base }: { base: string }) {
  const { t } = useT();
  const [counts, setCounts] = useState<Map<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api<TemplateSummary[]>('/templates?limit=100');
      if (cancelled || !res.ok) return;
      const map = new Map<string, number>();
      for (const tpl of res.data) {
        const code = tpl.category ?? 'website';
        map.set(code, (map.get(code) ?? 0) + 1);
      }
      setCounts(map);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const codes = counts
    ? [...CATEGORY_ORDER.filter((c) => counts.has(c)), ...[...counts.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort()]
    : [];
  const items: NavMenuItem[] = codes.map((code) => {
    const label = t(`ui.category.${code}`);
    return { href: `${base}/templates?category=${code}`, label: label === `ui.category.${code}` ? code : label };
  });
  items.push({ href: `${base}/templates`, label: t('ui.home.browse_all') });
  return <NavMenu href={`${base}/templates`} label={t('ui.nav.templates')} caption={t('ui.nav.templates')} items={items} />;
}


/** "Tài khoản" menu: the account area's own nav, plus sign-out behind a divider. */
function AccountMenu() {
  const { t } = useT();
  const router = useRouter();
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    router.replace('/auth/login');
    router.refresh();
  }
  return (
    <NavMenu
      href="/account"
      label={t('ui.nav.account')}
      caption={t('ui.nav.account')}
      items={[
        { href: '/account', label: t('ui.account.nav.overview') },
        { href: '/account/purchases', label: t('ui.account.nav.purchases') },
        { href: '/account/orders', label: t('ui.account.nav.orders') },
        { href: '/account/sites', label: t('ui.account.nav.sites') },
        { href: '/account/saved', label: t('ui.account.nav.saved') },
        { href: '/account/support', label: t('ui.account.nav.support') },
        { href: '/account/settings', label: t('ui.account.nav.settings') },
        { href: '/account/security', label: t('ui.account.nav.security') },
      ]}
      footer={(
        <button type="button" className="nav-dropdown__item nav-dropdown__item--button nav-dropdown__item--divider" onClick={() => void logout()}>
          <span className="nav-dropdown__label">{t('ui.nav.logout')}</span>
        </button>
      )}
    />
  );
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

export function SiteHeader({ publicLocale }: { publicLocale?: 'vi' | 'en' }) {
  const { t, locale } = useT();
  const me = useMe();
  const saved = useSaved();
  const base = `/${publicLocale ?? locale}`;
  const isStaff = me.status === 'signed_in' && me.me.permissions.some((p) => p === 'template:read' || p === 'report:read');
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href={base} className="brand">
          <img src="/logo.svg" alt="" width={30} height={30} />
          <span className="brand__name">WEBMAKET</span>
        </Link>
        <form className="header-search" action={`${base}/templates`} method="get" role="search">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <label htmlFor="header-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
          <input id="header-search" type="search" name="q" placeholder={t('ui.catalog.search_placeholder')} />
        </form>
        <nav className="site-nav" aria-label={t('ui.nav.main')}>
          <CategoryMenu base={base} />
          <NavMenu
            href={`${base}/plans/compare`}
            label={t('ui.nav.plans')}
            caption={t('ui.nav.plans')}
            items={[
              { href: `${base}/templates?mode=hosted`, label: t('ui.plans.hosted_title') },
              { href: `${base}/templates?mode=selfhost`, label: t('ui.plans.selfhost_title') },
              { href: `${base}/plans/compare`, label: t('ui.plans.table_title') },
            ]}
          />
          <NavMenu
            href={`${base}/how-it-works`}
            label={t('ui.nav.how_it_works')}
            caption={t('ui.nav.how_it_works')}
            items={[
              { href: `${base}/how-it-works`, label: t('ui.nav.how_steps') },
              { href: `${base}/help`, label: t('ui.nav.help_center') },
              { href: `${base}/partners`, label: t('ui.footer.partners') },
              { href: `${base}/contact`, label: t('ui.footer.contact') },
            ]}
          />
          {me.status === 'signed_in' ? (
            <>
              {isStaff ? (
                <NavMenu
                  href="/admin"
                  label={t('ui.nav.admin')}
                  caption={t('ui.nav.admin')}
                  items={[
                    { href: '/admin', label: t('ui.nav.admin_overview') },
                    { href: '/admin/templates', label: t('ui.admin.nav.templates') },
                    { href: '/admin/imports/new', label: t('ui.admin.nav.import_new') },
                    { href: '/admin/partners', label: t('ui.admin.partners') },
                    { href: '/admin/settings', label: t('ui.nav.settings') },
                  ]}
                />
              ) : null}
              <AccountMenu />
            </>
          ) : null}
          <span className="header-icons">
            <Link href="/account/saved" className="icon-button" aria-label={t('ui.saved.title')}>
              <BookmarkIcon />
              {saved.ready && saved.ids.size > 0 ? <span className="icon-button__badge">{saved.ids.size}</span> : null}
            </Link>
            <Link href="/account/orders" className="icon-button" aria-label={t('ui.nav.orders')}>
              <CartIcon />
            </Link>
          </span>
          {me.status === 'anonymous' ? (
            <>
              <Link href="/auth/login" className="button button--secondary">{t('ui.nav.login')}</Link>
              <Link href="/auth/register" className="button">{t('ui.nav.register')}</Link>
            </>
          ) : null}
          <LanguageSwitch />
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { t, locale } = useT();
  const links: [string, string][] = [
    [`/${locale}/plans/compare`, 'ui.footer.plans'],
    [`/${locale}/how-it-works`, 'ui.footer.how_it_works'],
    [`/${locale}/help`, 'ui.footer.help'],
    [`/${locale}/partners`, 'ui.footer.partners'],
    [`/${locale}/policies/terms`, 'ui.footer.terms'],
    [`/${locale}/policies/privacy`, 'ui.footer.privacy'],
    [`/${locale}/contact`, 'ui.footer.contact'],
  ];
  return (
    <footer className="page-footer stack">
      <nav aria-label={t('ui.footer.nav')} className="row" style={{ justifyContent: 'center', gap: 'var(--space-4)' }}>
        {links.map(([href, key]) => <Link key={href} href={href}>{t(key)}</Link>)}
      </nav>
      <p>{t('ui.footer.note')}</p>
    </footer>
  );
}
