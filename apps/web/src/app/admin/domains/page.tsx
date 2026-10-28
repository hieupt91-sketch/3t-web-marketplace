'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Domain { id: string; site_id: string; site_name: string; hostname_ascii: string; status: string; is_primary: boolean; cert_expires_at: string | null }

/** A16 — admin domains: pending DNS/TLS failures/expiring, owner/site. */
function AdminDomainsInner() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Domain[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Domain[]>('/admin/domains');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.domains_title')}</h1>
      <p className="muted">{t('ui.admin.domains_note')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.domains_empty')}><p>{t('ui.admin.domains_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.domain_hostname')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.admin.domains_site')}</th><th>{t('ui.sites.domain_tls')}</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.hostname_ascii}{d.is_primary ? ` (${t('ui.sites.domain_primary')})` : ''}</td>
              <td><StatusBadge tone={d.status === 'verified' ? 'success' : 'neutral'}>{t(`ui.sites.domain_${d.status}`)}</StatusBadge></td>
              <td><Link href={`/admin/sites/${d.site_id}`}>{d.site_name}</Link></td>
              <td className="tabular">{d.cert_expires_at ? dt(d.cert_expires_at) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function AdminDomainsPage() {
  return (
    <RequirePermission permission="site:operate">
      <AdminDomainsInner />
    </RequirePermission>
  );
}
