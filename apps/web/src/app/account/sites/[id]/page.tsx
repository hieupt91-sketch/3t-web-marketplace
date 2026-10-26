'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Site {
  id: string; display_name: string; status: string; subdomain: string | null; url: string | null;
  default_locale: string; subscription: { current_period_end: string; status: string } | null;
  deployments: { id: string; operation: string; status: string }[];
}

/** C07 — site overview: URL, admin, status, version, expiry, quota, recent tasks. */
export default function SiteOverviewPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Site>(`/sites/${params.id}`);
    if (res.ok) setSite(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (site && (site.status === 'creating' || site.status === 'provision_failed')) router.replace(`/account/sites/${site.id}/creating`);
  }, [site, router]);
  if (error && !site) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!site) return <Loading />;
  if (site && (site.status === 'creating' || site.status === 'provision_failed')) return <Loading />;
  const tabs: [string, string][] = [
    ['domains', 'ui.sites.tab_domains'], ['billing', 'ui.sites.tab_billing'], ['backups', 'ui.sites.tab_backups'],
    ['updates', 'ui.sites.tab_updates'], ['members', 'ui.sites.tab_members'], ['data', 'ui.sites.tab_data'],
  ];
  return (
    <div className="stack">
      <p><Link href="/account/sites">← {t('ui.sites.back_list')}</Link></p>
      <h1>{site.display_name}</h1>
      <p>
        <StatusBadge tone={site.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${site.status}`)}</StatusBadge>{' '}
        <span className="muted">{t('ui.sites.subdomain_label')}: {site.subdomain ?? '—'} · {t('ui.sites.locale')}: {site.default_locale}</span>
      </p>
      {site.url ? <p><Link className="button" href={site.url} target="_blank" rel="noopener">{t('ui.sites.open_site')}</Link> <Link className="button button--secondary" href={`${site.url.replace(/\/$/, '')}/admin`} target="_blank" rel="noopener">{t('ui.sites.open_admin')}</Link></p> : null}
      {site.status === 'suspended' ? <p className="muted">{t('ui.sites.suspended_note')}</p> : null}
      {site.subscription ? <p className="muted">{t('ui.sites.expires')}: {dt(site.subscription.current_period_end)} ({t(`ui.sites.subscription_${site.subscription.status}`)})</p> : null}
      <div className="row">
        {tabs.map(([tab, key]) => <Link key={tab} className="button button--secondary" href={`/account/sites/${site.id}/${tab}`}>{t(key)}</Link>)}
      </div>
      <h2>{t('ui.sites.recent_tasks')}</h2>
      {site.deployments.length === 0 ? <p className="muted">{t('ui.sites.no_tasks')}</p> : (
        <ul>{site.deployments.slice(0, 5).map((d) => <li key={d.id}>{d.operation}: {d.status}</li>)}</ul>
      )}
      {site.status === 'active' ? (
        <div className="row">
          <button className="button button--secondary" onClick={() => void api(`/sites/${site.id}/restart`, { method: 'POST' }).then(() => void load())}>{t('ui.sites.restart')}</button>
        </div>
      ) : null}
    </div>
  );
}
