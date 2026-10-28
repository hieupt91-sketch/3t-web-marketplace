'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface RefundRow {
  id: string;
  order_id: string;
  amount_minor: string;
  currency: string;
  status: string;
  reason: string;
  created_at: string;
}

/** Admin refund queue: approve creates a provider refund; settlement still needs a verified event. */
function RefundsInner() {
  const { t, dt, locale } = useT();
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const res = await api<RefundRow[]>('/admin/refunds');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusy(id); setDone(false);
    const res = await api(`/admin/refunds/${id}/${action}`, { method: 'POST', body: action === 'reject' ? { reason: '' } : {} });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setDone(true);
    void load();
  }

  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.refunds_title')}</h1>
      {done ? <p role="status">{t('ui.admin.refunds_decided')}</p> : null}
      {error ? <ErrorState error={error} /> : null}
      {rows.length === 0 ? (
        <EmptyState title={t('ui.admin.refunds_empty')}><p>—</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.checkout.order_id')}</th><th>{t('ui.checkout.total')}</th><th>{t('ui.table.actions')}</th><th>{t('ui.checkout.issue_attempts')}</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.order_id.slice(0, 8)}…</td>
              <td className="tabular">{formatMoney({ amount_minor: r.amount_minor, currency: r.currency }, locale)}</td>
              <td>{t(`ui.refund.status.${r.status}`)}</td>
              <td>
                {r.status === 'requested' ? (
                  <div className="row">
                    <button type="button" className="button" disabled={busy === r.id} onClick={() => void decide(r.id, 'approve')}>{t('ui.admin.refunds_approve')}</button>
                    <button type="button" className="button button--secondary" disabled={busy === r.id} onClick={() => void decide(r.id, 'reject')}>{t('ui.admin.refunds_reject')}</button>
                  </div>
                ) : <span className="muted">{r.reason || '—'} · {dt(r.created_at)}</span>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function RefundsPage() {
  return <RequirePermission permission="payment:read"><RefundsInner /></RequirePermission>;
}
