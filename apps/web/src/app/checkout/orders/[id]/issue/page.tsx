'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order {
  id: string;
  payment_status: string;
  total_minor: string;
  currency: string;
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
  reason: string;
  created_at: string;
}

/** B05 — order issue screen: status, attempts, refund requests; no bank internals exposed. */
function Issue() {
  const { t, dt, locale } = useT();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [o, a, r] = await Promise.all([
      api<Order>(`/orders/${id}`),
      api<Attempt[]>(`/orders/${id}/payment-attempts`),
      api<Refund[]>(`/orders/${id}/refund-requests`),
    ]);
    if (!o.ok) return setError(o.error);
    setOrder(o.data);
    if (a.ok) setAttempts(a.data);
    if (r.ok) setRefunds(r.data);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function submitRefund(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setFormError(null); setDone(false);
    const res = await api(`/orders/${id}/refund-requests`, { method: 'POST', body: { amount_minor: amount, reason } });
    setBusy(false);
    if (!res.ok) return setFormError(res.error);
    setDone(true); setAmount(''); setReason('');
    void load();
  }

  if (error && !order) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!order) return <Loading />;
  const refundable = order.payment_status === 'paid' || order.payment_status === 'partially_refunded' || order.payment_status === 'refund_pending';

  return (
    <div className="stack">
      <h1>{t('ui.checkout.issue_title')}</h1>
      <p className="muted">{t('ui.checkout.issue_body')}</p>
      <div className="card stack">
        <dl className="details">
          <dt>{t('ui.checkout.order_id')}</dt><dd className="mono">{order.id}</dd>
          <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: order.total_minor, currency: order.currency }, locale)}</strong></dd>
        </dl>
        <StatusBadge tone={order.payment_status === 'paid' ? 'success' : order.payment_status === 'refunded' ? 'neutral' : 'warning'}>{t(`ui.order.status.${order.payment_status}`)}</StatusBadge>
        {order.payment_status === 'awaiting_payment' ? (
          <Link className="button" href={`/checkout/orders/${id}/pay`}>{t('ui.checkout.issue_pay_again')}</Link>
        ) : null}
      </div>

      <h2>{t('ui.checkout.issue_attempts')}</h2>
      {attempts.length === 0 ? (
        <EmptyState title={t('ui.checkout.issue_attempts')}><p className="muted">—</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.checkout.issue_attempts')}</th><th>{t('ui.checkout.total')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{attempts.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.provider}</td>
              <td className="tabular">{formatMoney({ amount_minor: a.amount_minor, currency: a.currency }, locale)}</td>
              <td>{a.status}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <h2>{t('ui.checkout.issue_refunds')}</h2>
      {refunds.length === 0 ? null : (
        <div className="table-wrap"><table className="table">
          <tbody>{refunds.map((r) => (
            <tr key={r.id}>
              <td className="tabular">{formatMoney({ amount_minor: r.amount_minor, currency: r.currency }, locale)}</td>
              <td>{t(`ui.refund.status.${r.status}`)}</td>
              <td className="muted">{r.reason || '—'}</td>
              <td className="tabular">{dt(r.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {refundable ? (
        <form className="card stack" onSubmit={(e) => void submitRefund(e)}>
          {done ? <p role="status">{t('ui.account.refund_requested')}</p> : null}
          {formError ? <ErrorState error={formError} /> : null}
          <label className="field">
            <span>{t('ui.account.refund_amount')}</span>
            <input className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="^[0-9]+$" />
          </label>
          <label className="field">
            <span>{t('ui.account.refund_reason')}</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
          <button type="submit" className="button" disabled={busy}>{busy ? t('ui.state.saving') : t('ui.account.refund_submit')}</button>
        </form>
      ) : null}
      <p className="muted">{t('ui.checkout.issue_support_note')}</p>
    </div>
  );
}

export default function IssuePage() {
  return <AuthGate>{() => <Issue />}</AuthGate>;
}
