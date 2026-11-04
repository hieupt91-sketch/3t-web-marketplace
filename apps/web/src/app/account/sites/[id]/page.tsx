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
  capabilities?: string[]; domain_paid_until?: string | null; storage_quota_gb?: number | null;
  visual_edit?: { available: boolean; reason: string } | null;
}
interface VisualEditSession { edit_url: string; expires_at: string; candidates_count: number }
interface AdminSetup { setup_pending: boolean; setup_url: string | null; login_url: string | null; token: string | null }

/** C07 — site overview: URL, admin, status, version, expiry, quota, recent tasks. */
export default function SiteOverviewPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [setup, setSetup] = useState<AdminSetup | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  async function loadSetup() {
    setSetupBusy(true);
    const res = await api<AdminSetup>(`/sites/${params.id}/admin-setup`);
    setSetupBusy(false);
    if (res.ok) setSetup(res.data); else setError(res.error);
  }
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<ApiError | null>(null);
  async function openVisualEditor() {
    setEditBusy(true);
    setEditError(null);
    const res = await api<VisualEditSession>(`/sites/${params.id}/visual-edit/session`, { method: 'POST' });
    setEditBusy(false);
    if (res.ok) window.open(res.data.edit_url, '_blank', 'noopener');
    else setEditError(res.error);
  }
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
    ['content', 'ui.sites.tab_content'],
    ['domains', 'ui.sites.tab_domains'], ['billing', 'ui.sites.tab_billing'], ['backups', 'ui.sites.tab_backups'],
    ['updates', 'ui.sites.tab_updates'], ['members', 'ui.sites.tab_members'], ['data', 'ui.sites.tab_data'],
  ];
  return (
    <div className="stack">
      <p><Link href="/account/sites">← {t('ui.sites.back_list')}</Link></p>
      <h1>{site.display_name}</h1>
      <p>
        <StatusBadge tone={site.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${site.status}`)}</StatusBadge>{' '}
        <span className="muted">{t('ui.sites.subdomain_label')}: {site.subdomain ?? '—'} · {t('ui.sites.locale')}: {site.default_locale}{site.storage_quota_gb ? <> · {t('ui.sites.storage_quota', { gb: String(site.storage_quota_gb) })}</> : null}</span>
      </p>
      {site.url ? <p><Link className="button" href={site.url} target="_blank" rel="noopener">{t('ui.sites.open_site')}</Link> <Link className="button button--secondary" href={`${site.url.replace(/\/$/, '')}/admin`} target="_blank" rel="noopener">{t('ui.sites.open_admin')}</Link></p> : null}
      {(site.capabilities ?? []).includes('admin') ? (
        <div className="card stack">
          <strong>{t('ui.sites.admin_setup_title')}</strong>
          <p className="muted" style={{ margin: 0 }}>{t('ui.sites.admin_setup_body')}</p>
          {!setup ? (
            <div className="row"><button type="button" className="button button--secondary" disabled={setupBusy} onClick={() => void loadSetup()}>{setupBusy ? t('ui.state.loading') : t('ui.sites.admin_setup_button')}</button></div>
          ) : setup.setup_pending ? (
            <div className="stack">
              <p style={{ margin: 0 }}>{t('ui.sites.admin_setup_token_label')}: <strong className="mono">{setup.token}</strong></p>
              {setup.setup_url ? <p style={{ margin: 0 }}><Link className="button" href={setup.setup_url} target="_blank" rel="noopener">{t('ui.sites.admin_setup_open')}</Link></p> : null}
            </div>
          ) : (
            <p style={{ margin: 0 }}>{t('ui.sites.admin_setup_done')}{setup.login_url ? <> <Link href={setup.login_url} target="_blank" rel="noopener">{t('ui.sites.open_admin')}</Link></> : null}</p>
          )}
        </div>
      ) : null}
      {site.visual_edit && (site.visual_edit.available || site.visual_edit.reason === 'already_submitted') ? (
        <div className="card stack">
          <strong>{t('ui.visual_edit.card_title')}</strong>
          {site.visual_edit.available ? (
            <>
              <p className="muted" style={{ margin: 0 }}>{t('ui.visual_edit.card_body')}</p>
              <p style={{ margin: 0 }}>⚠ {t('ui.visual_edit.card_warning')}</p>
              {editError ? <ErrorState error={editError} /> : null}
              <div className="row"><button type="button" className="button" disabled={editBusy} onClick={() => void openVisualEditor()}>{editBusy ? t('ui.state.loading') : t('ui.visual_edit.open_button')}</button></div>
            </>
          ) : site.visual_edit.reason === 'already_submitted' ? (
            <p className="muted" style={{ margin: 0 }}>{t('ui.visual_edit.used_note')}</p>
          ) : null}
        </div>
      ) : null}
      {site.subdomain ? (
        <div className="card stack">
          <strong>{t('ui.sites.domain_pkg_title')}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {site.domain_paid_until
              ? (new Date(site.domain_paid_until).getFullYear() > 9000 ? t('ui.sites.domain_pkg_forever') : t('ui.sites.domain_pkg_until', { date: dt(site.domain_paid_until) }))
              : t('ui.sites.domain_pkg_never')}
          </p>
          <div className="row"><Link className="button button--secondary" href={`/checkout/domain?site=${site.id}`}>{site.domain_paid_until ? t('ui.sites.domain_pkg_renew') : t('ui.sites.domain_pkg_buy')}</Link></div>
        </div>
      ) : null}
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
          <button type="button" className="button button--secondary" onClick={() => void api(`/sites/${site.id}/restart`, { method: 'POST' }).then(() => void load())}>{t('ui.sites.restart')}</button>
        </div>
      ) : null}
    </div>
  );
}
