'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/use-me';
import { useSaved } from '@/lib/saved';
import { LanguageSwitch } from './language-switch';

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
        <nav className="site-nav" aria-label={t('ui.nav.main')}>
          <Link href={`${base}/templates`}>{t('ui.nav.templates')}</Link>
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
