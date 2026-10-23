'use client';

import Link from 'next/link';
import { useCurrentUser } from '@/components/dashboard-shell';
import { Alert, EmptyState } from '@/components/ui';
import { useT } from '@/lib/i18n';

/** C01 — customer home. Purchases/sites appear once commerce (M4) and hosting (M5) exist. */
export default function AccountHome() {
  const me = useCurrentUser();
  const { t, locale } = useT();
  return (
    <div className="stack">
      <h1>{t('ui.account.title', { name: me.display_name })}</h1>
      {!me.verified ? (
        <Alert tone="warning" title={t('ui.account.unverified_title')}>
          <p>{t('ui.account.unverified_body')}</p>
          <p><Link href="/auth/verify">{t('ui.auth.verify.resend_link')}</Link></p>
        </Alert>
      ) : null}
      <EmptyState title={t('ui.account.purchases_empty_title')} action={<Link className="button" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>}>
        <p>{t('ui.account.purchases_empty_body')}</p>
      </EmptyState>
    </div>
  );
}
