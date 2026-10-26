'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface DownloadsData {
  entitlement: { id: string; mode: string; status: string; updates_until: string | null; template_slug: string; version: string };
  downloads: { id: string; issued_at: string; used: boolean; expired: boolean }[];
}

/** C03 — per-entitlement downloads: eligible version only, history, fresh link on demand. */
function DownloadsInner() {
  const { t, dt } = useT();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DownloadsData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<DownloadsData>(`/entitlements/${id}/downloads`);
    if (res.ok) setData(res.data); else setError(res.error);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function freshLink() {
    setBusy(true); setActionError(null);
    const res = await api<{ url: string }>(`/entitlements/${id}/download-links`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    window.location.href = res.data.url;
  }

  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  const e = data.entitlement;
  return (
    <div className="stack">
      <h1>{t('ui.account.downloads_title')}</h1>
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="mono">{e.template_slug}</strong>
          <StatusBadge tone={e.status === 'active' ? 'success' : 'neutral'}>{t(`ui.entitlement.status.${e.status}`)}</StatusBadge>
        </div>
        <dl className="details">
          <dt>{t('ui.template_edit.version')}</dt><dd className="mono">{e.version}</dd>
          {e.updates_until ? <><dt>{t('ui.plan.updates')}</dt><dd className="tabular">{dt(e.updates_until)}</dd></> : null}
        </dl>
        {actionError ? <ErrorState error={actionError} /> : null}
        {e.mode === 'selfhost' ? (
          <button type="button" className="button" disabled={busy || e.status !== 'active'} onClick={() => void freshLink()}>
            {busy ? t('ui.state.saving') : t('ui.account.download_new_link')}
          </button>
        ) : null}
      </div>
      <h2>{t('ui.account.download_history')}</h2>
      {data.downloads.length === 0 ? (
        <EmptyState title={t('ui.account.download_history')}><p>{t('ui.account.downloads_empty_body')}</p></EmptyState>
      ) : (
        <ul>{data.downloads.map((d) => (
          <li key={d.id} className="tabular">{dt(d.issued_at)} — {d.used ? t('ui.state.done') : d.expired ? t('ui.entitlement.status.expired') : t('ui.step.status.pending')}</li>
        ))}</ul>
      )}
    </div>
  );
}

export default function DownloadsPage() {
  return <DownloadsInner />;
}
