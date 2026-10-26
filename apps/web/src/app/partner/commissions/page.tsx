'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface Entry { id: string; order_id: string; kind: string; status: string; amount_minor: string; base_minor: string; rate_bps: number; eligible_at: string | null; reason: string; created_at: string }

export default function PartnerCommissions() {
  const { t, locale } = useT();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [balance, setBalance] = useState<{ pending: string; eligible: string; reserved: string; paid: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ entries: Entry[]; balance: { pending: string; eligible: string; reserved: string; paid: string } }>('/partner/commissions');
    if (!res.ok) return setError(res.error);
    setEntries(res.data.entries); setBalance(res.data.balance); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.commissions')}</h1>
      {balance ? <p>{t('ui.partner.pending')}: {formatMoney({ amount_minor: balance.pending, currency: 'VND' }, locale)} · {t('ui.partner.eligible')}: {formatMoney({ amount_minor: balance.eligible, currency: 'VND' }, locale)}</p> : null}
      {entries.length === 0 ? <EmptyState title={t('ui.partner.commissions')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.checkout.order_id')}</th><th>{t('ui.partner.commissions')}</th><th>{t('ui.partner.status')}</th></tr></thead>
        <tbody>{entries.map((r) => (<tr key={r.id}><td className="mono">{r.order_id.slice(0, 8)}…</td><td>{r.kind} · {formatMoney({ amount_minor: r.amount_minor, currency: 'VND' }, locale)}</td><td>{r.status}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
