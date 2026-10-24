'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { useMe } from '@/lib/use-me';
import { LanguageSwitch } from './language-switch';

export function SiteHeader({ publicLocale }: { publicLocale?: 'vi' | 'en' }) {
  const { t, locale } = useT();
  const me = useMe();
  const base = `/${publicLocale ?? locale}`;
  const isStaff = me.status === 'signed_in' && me.me.permissions.some((p) => p === 'template:read' || p === 'report:read');
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href={base} className="brand">
          3T Web Marketplace
        </Link>
        <nav className="site-nav" aria-label={t('ui.nav.main')}>
          <Link href={`${base}/templates`}>{t('ui.nav.templates')}</Link>
          {me.status === 'signed_in' ? (
            <>
              {isStaff ? <Link href="/admin">{t('ui.nav.admin')}</Link> : null}
              <Link href="/account">{t('ui.nav.account')}</Link>
            </>
          ) : me.status === 'anonymous' ? (
            <>
              <Link href="/auth/login">{t('ui.nav.login')}</Link>
              <Link href="/auth/register">{t('ui.nav.register')}</Link>
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
    [`/${locale}/how-it-works`, 'ui.footer.how_it_works'],
    [`/${locale}/help`, 'ui.footer.help'],
    [`/${locale}/partners`, 'ui.footer.partners'],
    [`/${locale}/policies/terms`, 'ui.footer.terms'],
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
