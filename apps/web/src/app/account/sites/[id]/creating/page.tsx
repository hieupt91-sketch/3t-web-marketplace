'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Site { id: string; display_name: string; status: string; deployments: { id: string; operation: string; status: string; error_code: string | null }[] }

/** C06 — provisioning checklist with real progress, elapsed, retry/support. */
export default function SiteCreatingPage() {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    const res = await api<Site>(`/sites/${params.id}`);
    if (res.ok) setSite(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (site?.status === 'creating') {
      const timer = setInterval(() => { setNow(Date.now()); void load(); }, 3000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [site?.status, load]);
  if (error && !site) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!site) return <Loading />;
  const seconds = Math.floor((now - started) / 1000);
  return (
    <div className="stack">
      <h1>{t('ui.sites.creating_title', { name: site.display_name })}</h1>
      <p><StatusBadge tone={site.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${site.status}`)}</StatusBadge> <span className="muted">{t('ui.sites.elapsed', { seconds: String(seconds) })}</span></p>
      <ol className="stack">
        <li>{t('ui.sites.step_reserve')}</li>
        <li>{t('ui.sites.step_volume')}</li>
        <li>{t('ui.sites.step_runtime')}</li>
        <li>{t('ui.sites.step_health')}</li>
        <li>{t('ui.sites.step_route')}</li>
      </ol>
      {site.deployments.map((d) => (
        <p key={d.id} style={{ margin: 0 }}>{d.operation}: {d.status}{d.error_code ? ` (${d.error_code})` : ''}</p>
      ))}
      {site.status === 'active' ? <p><Link className="button" href={`/account/sites/${site.id}`}>{t('ui.sites.open_site')}</Link></p> : null}
      {site.status === 'provision_failed' ? (
        <>
          <p className="muted">{t('ui.sites.failed_note')}</p>
          <div className="row">
            <button className="button" onClick={() => void api(`/sites/${site.id}/retry`, { method: 'POST' }).then(() => void load())}>{t('ui.sites.retry')}</button>
            <Link className="button button--secondary" href="/account/support">{t('ui.sites.contact_support')}</Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
