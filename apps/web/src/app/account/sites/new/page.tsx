'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Entitlement { id: string; mode: string; status: string; instance_limit: number; template: { slug: string }; version: { semver: string } }

/** C05 — create a site in 4 steps: entitlement → name/locale → subdomain/seed → confirm. */
export default function NewSitePage() {
  const { t } = useT();
  const router = useRouter();
  const [ents, setEnts] = useState<Entitlement[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [entitlementId, setEntitlementId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [locale, setLocale] = useState<'vi' | 'en'>('vi');
  const [demoSessionId, setDemoSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Entitlement[]>('/me/entitlements').then((res) => {
      if (res.ok) setEnts(res.data.filter((e) => e.mode === 'hosted' && e.status === 'active'));
      else setError(res.error);
    });
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    void api<{ id: string }>('/sites', { method: 'POST', body: { entitlement_id: entitlementId, display_name: displayName, subdomain, default_locale: locale, demo_session_id: demoSessionId || undefined } }).then((res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      else router.push(`/account/sites/${res.data.id}/creating`);
    });
  };
  if (error && !ents) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (!ents) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.sites.new_title')}</h1>
      <ol className="stack">
        <li>{t('ui.sites.step_entitlement')}</li>
        <li>{t('ui.sites.step_name')}</li>
        <li>{t('ui.sites.step_subdomain')}</li>
        <li>{t('ui.sites.step_confirm')}</li>
      </ol>
      {ents.length === 0 ? (
        <p className="muted">{t('ui.sites.no_entitlement')}</p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span>{t('ui.sites.step_entitlement')}</span>
            <select className="select" value={entitlementId} onChange={(e) => setEntitlementId(e.target.value)} required>
              <option value="">{t('ui.sites.choose_entitlement')}</option>
              {ents.map((e) => <option key={e.id} value={e.id}>{e.template.slug} v{e.version.semver} ({t('ui.sites.instances', { limit: String(e.instance_limit) })})</option>)}
            </select>
          </label>
          <label className="field"><span>{t('ui.sites.display_name')}</span><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} required /></label>
          <label className="field">
            <span>{t('ui.sites.locale')}</span>
            <select className="select" value={locale} onChange={(e) => setLocale(e.target.value as 'vi' | 'en')}>
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="field"><span>{t('ui.sites.subdomain')}</span><input className="input mono" value={subdomain} onChange={(e) => setSubdomain(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9-]{2,39}" required /><span className="field__hint">{t('ui.sites.subdomain_hint')}</span></label>
          <label className="field"><span>{t('ui.sites.demo_session')}</span><input className="input mono" value={demoSessionId} onChange={(e) => setDemoSessionId(e.target.value)} placeholder={t('ui.sites.demo_session_hint')} /></label>
          {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
          <div className="row"><button className="button" type="submit" disabled={busy || !entitlementId}>{t('ui.sites.create')}</button></div>
        </form>
      )}
    </div>
  );
}
