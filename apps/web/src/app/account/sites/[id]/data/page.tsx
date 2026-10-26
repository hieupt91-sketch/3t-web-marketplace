'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** C15 — data: export, retention, delete schedule with cancel. No instant purge. */
export default function SiteDataPage() {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const [site, setSite] = useState<{ display_name: string; status: string; purge_at: string | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ display_name: string; status: string; purge_at: string | null }>(`/sites/${params.id}`);
    if (res.ok) setSite(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const act = (action: string) => {
    void api(`/sites/${params.id}/${action}`, { method: 'POST' }).then((res) => {
      if (!res.ok) setError(res.error); else void load();
    });
  };
  if (error && !site) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!site) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.data_title')}</h1>
      <p><StatusBadge tone={site.status === 'delete_scheduled' ? 'warning' : 'neutral'}>{t(`ui.sites.status.${site.status}`)}</StatusBadge></p>
      <div className="card stack">
        <p style={{ margin: 0 }}><strong>{t('ui.sites.data_export_title')}</strong></p>
        <p style={{ margin: 0 }} className="muted">{t('ui.sites.data_export_body')}</p>
        <div className="row"><button className="button button--secondary" onClick={() => void api(`/sites/${params.id}/exports`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); })}>{t('ui.sites.export_create')}</button></div>
        <p style={{ margin: 0 }}><Link href={`/account/sites/${params.id}/backups`}>{t('ui.sites.data_exports_link')}</Link></p>
      </div>
      <div className="card stack">
        <p style={{ margin: 0 }}><strong>{t('ui.sites.data_delete_title')}</strong></p>
        <p style={{ margin: 0 }} className="muted">{t('ui.sites.data_delete_body')}</p>
        {site.status === 'delete_scheduled' ? (
          <>
            <p style={{ margin: 0 }}>{t('ui.sites.data_purge_at', { at: site.purge_at ?? '' })}</p>
            <div className="row"><button className="button" onClick={() => act('cancel-delete')}>{t('ui.sites.data_cancel_delete')}</button></div>
          </>
        ) : (
          <div className="row"><button className="button button--danger" onClick={() => act('delete-request')}>{t('ui.sites.data_request_delete')}</button></div>
        )}
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
