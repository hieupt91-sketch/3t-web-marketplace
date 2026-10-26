'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface Account { id: string; code: string; display_name: string; status: string; balance: { pending: string; eligible: string; reserved: string; paid: string; available: string } | null }

export default function PartnerHome() {
  const { t, locale } = useT();
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Account>('/partner/account');
    if (!res.ok) return setError(res.error);
    setAccount(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  if (!account) return <EmptyState title={t('ui.partner.apply')}><p>{t('ui.partner.apply_help')}</p></EmptyState>;
  const b = account.balance;
  return (
    <div className="stack">
      <h1>{t('ui.partner.title')}</h1>
      <p>{account.display_name} · {account.code} · {account.status}</p>
      {b ? (
        <dl>
          <div><dt>{t('ui.partner.pending')}</dt><dd>{formatMoney({ amount_minor: b.pending, currency: 'VND' }, locale)}</dd></div>
          <div><dt>{t('ui.partner.eligible')}</dt><dd>{formatMoney({ amount_minor: b.eligible, currency: 'VND' }, locale)}</dd></div>
          <div><dt>{t('ui.partner.reserved')}</dt><dd>{formatMoney({ amount_minor: b.reserved, currency: 'VND' }, locale)}</dd></div>
          <div><dt>{t('ui.partner.paid')}</dt><dd>{formatMoney({ amount_minor: b.paid, currency: 'VND' }, locale)}</dd></div>
        </dl>
      ) : <p>{t('ui.partner.apply_help')}</p>}
    </div>
  );
}
