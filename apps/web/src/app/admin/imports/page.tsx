'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { importTone } from '@/lib/status';

interface ImportItem {
  id: string;
  name: string;
  status: string;
  detected_adapter: string | null;
  error_code: string | null;
  created_at: string;
}

function ImportsInner() {
  const { t, dt } = useT();
  const me = useCurrentUser();
  const [rows, setRows] = useState<ImportItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    void api<ImportItem[]>('/admin/imports?limit=100').then((res) => (res.ok ? setRows(res.data) : setError(res.error)));
  }, []);
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('ui.admin.imports.title')}</h1>
        {me.permissions.includes('template:import') ? <Link className="button" href="/admin/imports/new">{t('ui.admin.nav.import_new')}</Link> : null}
      </div>
      {error ? <ErrorState error={error} /> : null}
      {!rows && !error ? <Loading /> : null}
      {rows && rows.length === 0 ? <EmptyState title={t('ui.admin.imports.empty')} /> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.admin.imports.col_name')}</th>
                <th scope="col">{t('ui.admin.imports.col_status')}</th>
                <th scope="col">{t('ui.admin.imports.col_adapter')}</th>
                <th scope="col">{t('ui.admin.imports.col_created')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><Link href={`/admin/imports/${row.id}`}>{row.name}</Link></td>
                  <td>
                    <StatusBadge tone={importTone(row.status)}>{t(`ui.import.status.${row.status}`)}</StatusBadge>
                    {row.error_code ? <div className="muted mono">{row.error_code}</div> : null}
                  </td>
                  <td>{row.detected_adapter ?? '—'}</td>
                  <td className="tabular">{dt(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function AdminImports() {
  return (
    <RequirePermission permission="template:read">
      <ImportsInner />
    </RequirePermission>
  );
}
