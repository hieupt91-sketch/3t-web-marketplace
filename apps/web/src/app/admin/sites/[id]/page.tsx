'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface SiteDetail {
  id: string; display_name: string; status: string; subdomain: string | null; runtime_port: number | null;
  deployments: { id: string; operation: string; status: string }[];
  domains: { id: string; hostname_ascii: string; status: string; is_primary: boolean }[];
  subscription: { status: string; current_period_end: string } | null;
  members: { user_id: string; role: string; email: string }[];
}

/** A15 — admin site detail: operations from the allowlist, each with a reason. */
function AdminSiteInner() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [action, setAction] = useState<'restart' | 'suspend' | 'resume'>('restart');
  const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    const res = await api<SiteDetail>(`/admin/sites/${params.id}`);
    if (res.ok) setSite(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void api(`/admin/sites/${params.id}/operations`, { method: 'POST', body: { action, reason } }).then((res) => {
      if (!res.ok) setError(res.error); else { setReason(''); void load(); }
    });
  };
  if (error && !site) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!site) return <Loading />;
  return (
    <div className="stack">
      <p><Link href="/admin/sites">← {t('ui.admin.sites_back')}</Link></p>
      <h1>{site.display_name}</h1>
      <p><StatusBadge tone={site.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${site.status}`)}</StatusBadge> <span className="muted">{site.subdomain ?? '—'} · {site.runtime_port ? `127.0.0.1:${site.runtime_port}` : t('ui.admin.sites_no_runtime')}</span></p>
      {site.subscription ? <p className="muted">{t('ui.sites.expires')}: {dt(site.subscription.current_period_end)} ({site.subscription.status})</p> : null}
      <form className="stack" onSubmit={submit}>
        <label className="field" style={{ maxWidth: 300 }}>
          <span>{t('ui.admin.sites_operation')}</span>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value as 'restart' | 'suspend' | 'resume')}>
            <option value="restart">{t('ui.admin.sites_restart')}</option>
            <option value="suspend">{t('ui.admin.sites_suspend')}</option>
            <option value="resume">{t('ui.admin.sites_resume')}</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 500 }}><span>{t('ui.admin.sites_reason')}</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required /></label>
        <div className="row"><button className="button" type="submit" disabled={reason.trim().length < 3}>{t('ui.admin.sites_run')}</button></div>
      </form>
      <h2>{t('ui.sites.recent_tasks')}</h2>
      <ul>{site.deployments.map((d) => <li key={d.id}>{d.operation}: {d.status}</li>)}</ul>
      <h2>{t('ui.sites.domains_title')}</h2>
      <ul>{site.domains.map((d) => <li key={d.id} className="mono">{d.hostname_ascii} ({d.status}){d.is_primary ? ` — ${t('ui.sites.domain_primary')}` : ''}</li>)}</ul>
      <h2>{t('ui.sites.members_title')}</h2>
      <ul>{site.members.map((m) => <li key={m.user_id}>{m.email} ({m.role})</li>)}</ul>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}

export default function AdminSitePage() {
  return (
    <RequirePermission permission="site:operate">
      <AdminSiteInner />
    </RequirePermission>
  );
}
