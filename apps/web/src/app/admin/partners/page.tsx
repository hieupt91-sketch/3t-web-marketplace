'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
interface Partner { id: string; code: string; display_name: string; domain: string; status: string; review_reason: string; created_at: string }

function PartnersInner() {
  const { t } = useT();
  const [rows, setRows] = useState<Partner[]>([]);
  const [decision, setDecision] = useState('approve');
  const [reason, setReason] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Partner[]>('/admin/partners');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function review(id: string) {
    const res = await api(`/admin/partners/${id}/review`, { method: 'POST', body: { decision, reason } });
    if (!res.ok) return setError(res.error);
    void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.partners')}</h1>
      {error ? <ErrorState error={error} /> : null}
      <label>{t('ui.admin.partners_review')}<select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="approve">approve</option><option value="reject">reject</option><option value="suspend">suspend</option><option value="reactivate">reactivate</option></select></label>
      <label>{t('ui.partner.description')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.partners')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.display_name')}</th><th>{t('ui.partner.status')}</th><th>{t('ui.table.actions')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.display_name} · {r.domain}</td><td>{r.status}</td><td><button className="button" onClick={() => void review(r.id)}>{t('ui.admin.partners_review')}</button></td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

export default function AdminPartners() {
  return <RequirePermission permission="partner:read"><PartnersInner /></RequirePermission>;
}
