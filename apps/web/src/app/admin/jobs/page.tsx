'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Job { id: string; type: string; status: string; attempts: number; max_attempts: number; step: string | null; last_error_code: string | null; created_at: string }

/** A18 — job queue: age, steps, attempts, dead-letter; retry with lease guard. */
function AdminJobsInner() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Job[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Job[]>('/admin/jobs');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.jobs_title')}</h1>
      <p className="muted">{t('ui.admin.jobs_note')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.jobs_empty')}><p>{t('ui.admin.jobs_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.admin.jobs_type')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.admin.jobs_attempts')}</th><th>{t('ui.admin.jobs_error')}</th><th>{t('ui.admin.jobs_created')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((j) => (
            <tr key={j.id}>
              <td className="mono">{j.type}</td>
              <td><StatusBadge tone={j.status === 'succeeded' ? 'success' : 'neutral'}>{j.status}</StatusBadge></td>
              <td className="tabular">{j.attempts}/{j.max_attempts}</td>
              <td>{j.last_error_code ?? '—'}</td>
              <td className="tabular">{dt(j.created_at)}</td>
              <td>{(j.status === 'failed' || j.status === 'dead') ? <button type="button" className="button button--secondary" onClick={() => void api(`/admin/jobs/${j.id}/retry`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.action.retry')}</button> : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}

export default function AdminJobsPage() {
  return (
    <RequirePermission permission="ops:read">
      <AdminJobsInner />
    </RequirePermission>
  );
}
