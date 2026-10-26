'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Site { id: string; display_name: string; subdomain: string | null; status: string; runtime_port: number | null; owner_id: string; subscription_end: string | null }

/** A15 — admin sites list: runtime/node, quota, version, subscription, health. */
function AdminSitesInner() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Site[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Site[]>('/admin/sites');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.sites_title')}</h1>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.sites_empty')}><p>{t('ui.admin.sites_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.name')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.admin.sites_runtime')}</th><th>{t('ui.sites.expires')}</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}>
              <td><Link href={`/admin/sites/${s.id}`}>{s.display_name}</Link> <span className="muted">({s.subdomain ?? '—'})</span></td>
              <td><StatusBadge tone={s.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${s.status}`)}</StatusBadge></td>
              <td className="tabular">{s.runtime_port ? `127.0.0.1:${s.runtime_port}` : '—'}</td>
              <td className="tabular">{s.subscription_end ? dt(s.subscription_end) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function AdminSitesPage() {
  return (
    <RequirePermission permission="site:operate">
      <AdminSitesInner />
    </RequirePermission>
  );
}
