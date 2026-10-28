'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface OrderDetail {
  id: string;
  payment_status: string;
  total_minor: string;
  currency: string;
  terms_version: string;
  items: { template_id: string; deployment_mode: string; unit_price_minor: string }[];
  paid_at: string | null;
  created_at: string;
}
interface Attempt {
  id: string;
  provider: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: string;
}
interface Refund {
  id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: string;
}

/** C04 — buyer order detail: totals, items, attempts, refunds. No invoice claim when none exists. */
function OrderDetailInner() {
  const { t, dt, locale } = useT();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const [o, a, r] = await Promise.all([
      api<OrderDetail>(`/orders/${id}`),
      api<Attempt[]>(`/orders/${id}/payment-attempts`),
      api<Refund[]>(`/orders/${id}/refund-requests`),
    ]);
    if (!o.ok) return setError(o.error);
    setOrder(o.data);
    if (a.ok) setAttempts(a.data);
    if (r.ok) setRefunds(r.data);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error && !order) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!order) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.account.orders_title')}</h1>
      <div className="card stack">
        <dl className="details">
          <dt>{t('ui.checkout.order_id')}</dt><dd className="mono">{order.id}</dd>
          <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: order.total_minor, currency: order.currency }, locale)}</strong></dd>
          <dt>{t('ui.checkout.issue_attempts')}</dt><dd>{dt(order.created_at)}{order.paid_at ? ` → ${dt(order.paid_at)}` : ''}</dd>
        </dl>
        <StatusBadge tone={order.payment_status === 'paid' ? 'success' : 'neutral'}>{t(`ui.order.status.${order.payment_status}`)}</StatusBadge>
        <div className="row">
          <Link className="button button--secondary" href={`/checkout/orders/${id}/issue`}>{t('ui.checkout.issue_title')}</Link>
          {order.payment_status === 'awaiting_payment' ? <Link className="button" href={`/checkout/orders/${id}/pay`}>{t('ui.checkout.issue_pay_again')}</Link> : null}
        </div>
      </div>
      <h2>{t('ui.account.order_items')}</h2>
      {order.items.length === 0 ? <EmptyState title={t('ui.account.order_items')}><p>—</p></EmptyState> : (
        <ul>{order.items.map((item, i) => (
          <li key={i} className="tabular">{item.deployment_mode} — {formatMoney({ amount_minor: item.unit_price_minor, currency: order.currency }, locale)}</li>
        ))}</ul>
      )}
      <h2>{t('ui.checkout.issue_attempts')}</h2>
      <ul>{attempts.map((a) => <li key={a.id}>{a.provider} · {formatMoney({ amount_minor: a.amount_minor, currency: a.currency }, locale)} · {a.status} · {dt(a.created_at)}</li>)}</ul>
      <h2>{t('ui.account.refund_requests')}</h2>
      <ul>{refunds.map((r) => <li key={r.id}>{formatMoney({ amount_minor: r.amount_minor, currency: r.currency }, locale)} · {t(`ui.refund.status.${r.status}`)} · {dt(r.created_at)}</li>)}</ul>
    </div>
  );
}

export default function OrderDetailPage() {
  return <OrderDetailInner />;
}
