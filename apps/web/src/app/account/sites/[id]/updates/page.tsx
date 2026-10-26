'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Deployment { id: string; operation: string; status: string; version_id: string; error_code: string | null; created_at: string }
interface Site { id: string; template_version_id: string; deployments: Deployment[] }

/** C11 — updates: current/available, progress, rollback via restore. */
export default function SiteUpdatesPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [site, setSite] = useState<Site | null>(null);
  const [versions, setVersions] = useState<{ id: string; semver: string }[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Site>(`/sites/${params.id}`);
    if (res.ok) {
      setSite(res.data);
      const templateId = (res.data as unknown as { template_id?: string }).template_id;
      if (templateId) {
        const v = await api<{ id: string; semver: string }[]>(`/admin/templates/${templateId}/versions`);
        if (v.ok) setVersions(v.data);
      }
    } else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !site) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!site) return <Loading />;
  const others = versions.filter((v) => v.id !== site.template_version_id);
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.updates_title')}</h1>
      <p className="muted">{t('ui.sites.updates_current', { version: site.template_version_id.slice(0, 8) })}</p>
      {others.length > 0 ? (
        <div className="stack">
          <p>{t('ui.sites.updates_available')}</p>
          {others.map((v) => (
            <div key={v.id} className="row">
              <span className="mono">{v.semver}</span>
              <button className="button button--secondary" onClick={() => void api(`/sites/${params.id}/update`, { method: 'POST', body: { version_id: v.id } }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.update_action')}</button>
            </div>
          ))}
        </div>
      ) : <p className="muted">{t('ui.sites.updates_none')}</p>}
      <p className="muted">{t('ui.sites.updates_rollback_note')}</p>
      <h2>{t('ui.sites.recent_tasks')}</h2>
      <ul>{site.deployments.map((d) => <li key={d.id}>{d.operation}: <StatusBadge tone={d.status === 'succeeded' ? 'success' : 'neutral'}>{d.status}</StatusBadge> {d.error_code ? `(${d.error_code})` : ''} <span className="muted">{dt(d.created_at)}</span></li>)}</ul>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
