'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/use-me';
import { useSaved } from '@/lib/saved';
import { api } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { LanguageSwitch } from './language-switch';

const CATEGORY_ORDER = ['food', 'beauty', 'realestate', 'business', 'store', 'landing', 'portfolio', 'blog', 'website'];

/** One small stroke icon per category for the mega-menu tiles. */
function CategoryIcon({ code }: { code: string }) {
  const paths: Record<string, ReactNode> = {
    food: (<><path d="M3 18h18" /><path d="M5 18a7 7 0 0 1 14 0" /><path d="M12 11V9.5" /><circle cx="12" cy="8" r="1" /></>),
    beauty: (<><path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7z" /><path d="M18.5 15v4M16.5 17h4" /></>),
    realestate: (<><path d="M4 21h16" /><path d="M6 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16" /><path d="M14 9h3a1 1 0 0 1 1 1v11" /><path d="M9 8h2M9 12h2M9 16h2" /></>),
    business: (<><rect x="3" y="8" width="18" height="11" rx="2" /><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M3 13h18" /></>),
    store: (<><path d="M5.5 8h13l-1 12a2 2 0 0 1-2 1.8h-7A2 2 0 0 1 6.5 20L5.5 8z" /><path d="M9 10V6a3 3 0 0 1 6 0v4" /></>),
    landing: (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M6.5 6.5h.01M9.5 6.5h.01" /></>),
    portfolio: (<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m4.5 18 4.5-4.5 3 3L15 13.5l4.5 4.5" /></>),
    blog: (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></>),
    website: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z" /></>),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {paths[code] ?? paths.website}
    </svg>
  );
}

/**
 * "Mẫu website" menu with a hover/tap category dropdown: every template
 * category with its live count, each linking into the filtered catalog.
 * Opens on hover/focus for pointer users; the chevron toggles it for
 * touch. Counts come from the public catalog (best-effort: the menu
 * still lists categories when the count fetch fails).
 */
function CategoryMenu({ base }: { base: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
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
      <Link href={`${base}/templates`}>{t('ui.nav.templates')}</Link>
      <button
        type="button"
        className="nav-dropdown__toggle"
        aria-expanded={open}
        aria-label={t('ui.catalog.filter_category')}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <span className="nav-dropdown__panel" role="menu">
        {codes.map((code) => {
          const label = t(`ui.category.${code}`);
          return (
            <Link key={code} href={`${base}/templates?category=${code}`} className="nav-dropdown__item" onClick={() => setOpen(false)}>
              <span className={`nav-dropdown__icon nav-dropdown__icon--${code}`}>
                <CategoryIcon code={code} />
              </span>
              <span className="nav-dropdown__label">{label === `ui.category.${code}` ? code : label}</span>
              <span className="nav-dropdown__count">{counts?.get(code) ?? ''}</span>
            </Link>
          );
        })}
        <Link href={`${base}/templates`} className="nav-dropdown__item nav-dropdown__item--all" onClick={() => setOpen(false)}>
          <span className="nav-dropdown__label">{t('ui.home.browse_all')}</span>
          <span className="nav-dropdown__count">{counts ? [...counts.values()].reduce((a, b) => a + b, 0) : ''}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      </span>
    </span>
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
          <Link href={`${base}/plans/compare`}>{t('ui.nav.plans')}</Link>
          <Link href={`${base}/how-it-works`}>{t('ui.nav.how_it_works')}</Link>
          {me.status === 'signed_in' ? (
            <>
              {isStaff ? <Link href="/admin">{t('ui.nav.admin')}</Link> : null}
              <Link href="/account">{t('ui.nav.account')}</Link>
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
