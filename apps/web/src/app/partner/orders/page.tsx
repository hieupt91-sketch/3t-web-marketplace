'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
interface Order { id: string; status: string; total_minor: string; currency: string; created_at: string }

export default function PartnerOrders() {
  const { t } = useT();
  const [rows, setRows] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Order[]>('/partner/orders');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.orders')}</h1>
      <p>{t('ui.partner.buyer_masked')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.orders')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.checkout.order_id')}</th><th>{t('ui.partner.status')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td className="mono">{r.id.slice(0, 8)}…</td><td>{r.status}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
