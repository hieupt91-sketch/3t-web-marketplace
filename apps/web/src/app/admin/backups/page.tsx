'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Backup { id: string; site_id: string; site_name: string; kind: string; status: string; checksum: string | null; created_at: string }

/** A19 — admin backups: by node/site, failed jobs, retention, restore history. */
function AdminBackupsInner() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Backup[]>('/admin/backups');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.backups_title')}</h1>
      <p className="muted">{t('ui.admin.backups_note')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.backups_empty')}><p>{t('ui.admin.backups_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.admin.backups_site')}</th><th>{t('ui.sites.backup_kind')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.sites.backup_checksum')}</th><th>{t('ui.sites.backup_created')}</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td><Link href={`/admin/sites/${b.site_id}`}>{b.site_name}</Link></td>
              <td>{t(`ui.sites.backup_${b.kind}`)}</td>
              <td><StatusBadge tone={b.status === 'succeeded' ? 'success' : 'neutral'}>{t(`ui.sites.backup_${b.status}`)}</StatusBadge></td>
              <td className="mono">{b.checksum ? `${b.checksum.slice(0, 12)}…` : '—'}</td>
              <td className="tabular">{dt(b.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function AdminBackupsPage() {
  return (
    <RequirePermission permission="site:operate">
      <AdminBackupsInner />
    </RequirePermission>
  );
}
