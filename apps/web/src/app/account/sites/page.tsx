'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Site { id: string; display_name: string; subdomain: string | null; status: string; url: string | null; subscription_end: string | null }

/** C07 list — customer sites. */
export default function SitesPage() {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Site[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Site[]>('/sites');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('ui.sites.title')}</h1>
        <Link className="button" href="/account/sites/new">{t('ui.sites.new')}</Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t('ui.sites.empty')}><p>{t('ui.sites.empty_body')}</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.name')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.sites.url')}</th><th>{t('ui.sites.expires')}</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}>
              <td><Link href={s.status === 'creating' || s.status === 'provision_failed' ? `/account/sites/${s.id}/creating` : `/account/sites/${s.id}`}>{s.display_name}</Link></td>
              <td><StatusBadge tone={s.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${s.status}`)}</StatusBadge></td>
              <td>{s.url ? <Link href={s.url} target="_blank" rel="noopener">{s.url}</Link> : (s.subdomain ?? '—')}</td>
              <td className="tabular">{s.subscription_end ? dt(s.subscription_end) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
