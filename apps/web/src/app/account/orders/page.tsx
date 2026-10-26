'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order {
  id: string;
  payment_status: string;
  total_minor: string;
  currency: string;
  created_at: string;
  paid_at: string | null;
}

/** C04 — buyer order list. Detail + timeline live on the order page. */
function OrdersInner() {
  const { t, dt, locale } = useT();
  const [rows, setRows] = useState<Order[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const res = await api<Order[]>('/orders?limit=50');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.account.orders_title')}</h1>
      {rows.length === 0 ? (
        <EmptyState title={t('ui.account.orders_empty_title')}>
          <p>{t('ui.account.orders_empty_body')}</p>
        </EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.checkout.order_id')}</th><th>{t('ui.checkout.total')}</th><th>{t('ui.table.actions')}</th><th>{t('ui.checkout.issue_attempts')}</th></tr></thead>
          <tbody>{rows.map((o) => (
            <tr key={o.id}>
              <td><Link className="mono" href={`/account/orders/${o.id}`}>{o.id.slice(0, 8)}…</Link></td>
              <td className="tabular">{formatMoney({ amount_minor: o.total_minor, currency: o.currency }, locale)}</td>
              <td><StatusBadge tone={o.payment_status === 'paid' ? 'success' : 'neutral'}>{t(`ui.order.status.${o.payment_status}`)}</StatusBadge></td>
              <td className="tabular">{dt(o.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function OrdersPage() {
  return <OrdersInner />;
}
