'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Demo { id: string; version_id: string; status: string; runtime_port: number | null; expires_at: string }

/** A17 — admin demos: sessions/TTL/resource, reset/expire/cancel. */
function AdminDemosInner() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Demo[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Demo[]>('/admin/demos');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.demos_title')}</h1>
      <p className="muted">{t('ui.admin.demos_note')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.demos_empty')}><p>{t('ui.admin.demos_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.admin.demos_id')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.admin.demos_resource')}</th><th>{t('ui.sites.expires')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.id.slice(0, 8)}…</td>
              <td><StatusBadge tone={d.status === 'active' ? 'success' : 'neutral'}>{t(`ui.demo.status.${d.status}`)}</StatusBadge></td>
              <td className="tabular">{d.runtime_port ? `127.0.0.1:${d.runtime_port}` : '—'}</td>
              <td className="tabular">{dt(d.expires_at)}</td>
              <td>{d.status === 'active' ? <button className="button button--danger" onClick={() => void api(`/admin/demos/${d.id}/expire`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.admin.demos_expire')}</button> : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function AdminDemosPage() {
  return (
    <RequirePermission permission="ops:read">
      <AdminDemosInner />
    </RequirePermission>
  );
}
