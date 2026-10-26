'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
interface Payout { id: string; partner_name: string; amount_minor: string; status: string; evidence_ref: string | null; created_at: string }

function PayoutsInner() {
  const { t } = useT();
  const [rows, setRows] = useState<Payout[]>([]);
  const [evidence, setEvidence] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Payout[]>('/admin/payouts');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function act(id: string, action: string) {
    const body = action === 'settle' ? { evidence_ref: evidence } : {};
    const res = await api(`/admin/payouts/${id}/${action}`, { method: 'POST', body });
    if (!res.ok) return setError(res.error);
    void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.payouts')}</h1>
      {error ? <ErrorState error={error} /> : null}
      <label>{t('ui.admin.payout_evidence')}<input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="TRF-…" /></label>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.payouts')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.display_name')}</th><th>{t('ui.partner.balance')}</th><th>{t('ui.partner.status')}</th><th>{t('ui.table.actions')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.partner_name}</td><td>{r.amount_minor}</td><td>{r.status}</td><td><button className="button button--secondary" onClick={() => void act(r.id, 'approve')}>approve</button> <button className="button" onClick={() => void act(r.id, 'settle')}>settle</button> <button className="button button--danger" onClick={() => void act(r.id, 'fail')}>fail</button></td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

export default function AdminPayouts() {
  return <RequirePermission permission="payout:read"><PayoutsInner /></RequirePermission>;
}
