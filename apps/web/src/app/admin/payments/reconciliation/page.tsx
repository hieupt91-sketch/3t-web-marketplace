'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface ReconOrder {
  id: string;
  buyer_id: string;
  total_minor: string;
  currency: string;
  created_at: string;
  attempts: { provider_ref: string | null; amount_minor: string; currency: string; status: string }[];
}
interface ReconEvent {
  id: string;
  provider: string;
  provider_event_id: string;
  order_id: string | null;
  processing_status: string;
  received_at: string;
}

/** A12 — reconciliation queue. Resolving never edits raw provider events; it audits the decision. */
function ReconciliationInner() {
  const { t, dt, locale } = useT();
  const [orders, setOrders] = useState<ReconOrder[]>([]);
  const [events, setEvents] = useState<ReconEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState<'paid' | 'cancelled'>('paid');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ orders: ReconOrder[]; unmatched_events: ReconEvent[] }>('/admin/reconciliation');
    if (!res.ok) return setError(res.error);
    setOrders(res.data.orders); setEvents(res.data.unmatched_events); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function resolve(orderId: string) {
    setBusy(orderId); setDone(false);
    const res = await api(`/admin/reconciliation/orders/${orderId}/resolve`, { method: 'POST', body: { resolution, reason } });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setDone(true); setReason('');
    void load();
  }

  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.reconciliation_title')}</h1>
      {done ? <p role="status">{t('ui.admin.reconciliation_resolved')}</p> : null}
      {error ? <ErrorState error={error} /> : null}
      <h2>{t('ui.admin.reconciliation_orders')}</h2>
      {orders.length === 0 ? (
        <EmptyState title={t('ui.admin.reconciliation_empty')}><p>—</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.checkout.order_id')}</th><th>{t('ui.checkout.total')}</th><th>{t('ui.admin.reconciliation_resolve')}</th></tr></thead>
          <tbody>{orders.map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.id.slice(0, 8)}…</td>
              <td className="tabular">{formatMoney({ amount_minor: o.total_minor, currency: o.currency }, locale)}</td>
              <td>
                <div className="row">
                  <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value as 'paid' | 'cancelled')} aria-label={t('ui.admin.reconciliation_resolve')}>
                    <option value="paid">{t('ui.admin.reconciliation_resolution_paid')}</option>
                    <option value="cancelled">{t('ui.admin.reconciliation_resolution_cancelled')}</option>
                  </select>
                  <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('ui.admin.reconciliation_reason')} required minLength={3} />
                  <button type="button" className="button" disabled={busy === o.id || reason.trim().length < 3} onClick={() => void resolve(o.id)}>
                    {busy === o.id ? t('ui.state.saving') : t('ui.admin.reconciliation_resolve')}
                  </button>
                </div>
                <ul>{o.attempts.map((a, i) => <li key={i} className="muted">{a.provider_ref ?? '—'} · {formatMoney({ amount_minor: a.amount_minor, currency: a.currency }, locale)} · {a.status}</li>)}</ul>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <h2>{t('ui.admin.reconciliation_events')}</h2>
      <ul>{events.map((e) => <li key={e.id} className="mono">{e.provider}:{e.provider_event_id} · {e.processing_status} · {dt(e.received_at)}</li>)}</ul>
    </div>
  );
}

export default function ReconciliationPage() {
  return <RequirePermission permission="payment:read"><ReconciliationInner /></RequirePermission>;
}
