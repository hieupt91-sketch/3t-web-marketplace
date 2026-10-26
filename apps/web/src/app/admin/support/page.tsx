'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  locale: string;
  assigned_to: string | null;
  order_id: string | null;
  sla_breached: boolean;
  created_at: string;
}

const STATUSES = ['open', 'assigned', 'waiting', 'resolved', 'closed'] as const;

/** A26 — support queue with status filter and SLA breach flag. */
function SupportQueueInner() {
  const { t, dt } = useT();
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Ticket[]>(`/admin/support${status ? `?status=${status}` : ''}`);
    if (res.ok) setRows(res.data); else setError(res.error);
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.support.queue_title')}</h1>
      <label className="field" style={{ maxWidth: 280 }}>
        <span>{t('ui.support.filter_status')}</span>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('ui.catalog.filter_all')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`ui.support.status.${s}`)}</option>)}
        </select>
      </label>
      {rows.length === 0 ? (
        <EmptyState title={t('ui.support.queue_empty')}><p>{t('ui.support.queue_empty_body')}</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.support.subject')}</th><th>{t('ui.support.status')}</th><th>{t('ui.support.sla')}</th><th>{t('ui.support.created')}</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id}>
              <td><Link href={`/admin/support/${row.id}`}>{row.subject}</Link></td>
              <td><StatusBadge tone={row.status === 'resolved' || row.status === 'closed' ? 'success' : 'neutral'}>{t(`ui.support.status.${row.status}`)}</StatusBadge></td>
              <td>{row.sla_breached ? <StatusBadge tone="error">{t('ui.support.sla_breached')}</StatusBadge> : t('ui.support.sla_ok')}</td>
              <td className="tabular">{dt(row.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function SupportQueuePage() {
  return (
    <RequirePermission permission="support:read">
      <SupportQueueInner />
    </RequirePermission>
  );
}
