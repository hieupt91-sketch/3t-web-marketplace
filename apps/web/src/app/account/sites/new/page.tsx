'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Entitlement { id: string; mode: string; status: string; instance_limit: number; template: { slug: string }; version: { semver: string } }
interface SubCheck { available: boolean; reason: string | null; held_by_you?: boolean; reservation_expires_at?: string }

type HoldState =
  | { kind: 'available' }
  | { kind: 'held_you'; expiresAt: string }
  | { kind: 'held_other' }
  | { kind: 'taken' }
  | { kind: 'invalid' }
  | { kind: 'reserved' };

/** C05 — create a site in 4 steps: entitlement → name/locale → subdomain/seed → confirm. */
export default function NewSitePage() {
  const { t, dt } = useT();
  const router = useRouter();
  const [ents, setEnts] = useState<Entitlement[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [entitlementId, setEntitlementId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [locale, setLocale] = useState<'vi' | 'en'>('vi');
  const [demoSessionId, setDemoSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  // DEP-06: check-and-hold state for the subdomain step.
  const [hold, setHold] = useState<HoldState | null>(null);
  const [heldName, setHeldName] = useState('');
  const [holdBusy, setHoldBusy] = useState(false);

  async function checkHold() {
    const name = subdomain.trim().toLowerCase();
    if (!name) return;
    setHoldBusy(true);
    setError(null);
    const check = await api<SubCheck>(`/sites/check-subdomain?subdomain=${encodeURIComponent(name)}`);
    if (!check.ok) {
      setHoldBusy(false);
      setError(check.error);
      return;
    }
    if (!check.data.available) {
      setHoldBusy(false);
      setHold(
        check.data.reason === 'taken' ? { kind: 'taken' }
          : check.data.reason === 'reserved' ? { kind: 'reserved' }
            : check.data.reason === 'held' ? { kind: 'held_other' }
              : { kind: 'invalid' },
      );
      return;
    }
    if (check.data.held_by_you && check.data.reservation_expires_at) {
      setHoldBusy(false);
      setHeldName(name);
      setHold({ kind: 'held_you', expiresAt: check.data.reservation_expires_at });
      return;
    }
    // Switching to a new name releases the name this form held before.
    if (heldName && heldName !== name) {
      await api(`/sites/subdomain-reservations/${encodeURIComponent(heldName)}`, { method: 'DELETE' });
      setHeldName('');
    }
    const res = await api<{ subdomain: string; expires_at: string }>('/sites/subdomain-reservations', {
      method: 'POST',
      body: { subdomain: name, entitlement_id: entitlementId || undefined },
    });
    setHoldBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setHeldName(name);
    setHold({ kind: 'held_you', expiresAt: res.data.expires_at });
  }

  async function releaseHold() {
    if (!heldName) return;
    await api(`/sites/subdomain-reservations/${encodeURIComponent(heldName)}`, { method: 'DELETE' });
    setHeldName('');
    setHold(null);
  }
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
          <label className="field"><span>{t('ui.sites.subdomain')}</span><input className="input mono" value={subdomain} onChange={(e) => { setSubdomain(e.target.value.toLowerCase()); setHold(null); }} pattern="[a-z0-9][a-z0-9-]{2,39}" required /><span className="field__hint">{t('ui.sites.subdomain_hint')}</span></label>
          <div className="stack">
            <div className="row">
              <button type="button" className="button button--secondary" disabled={holdBusy || !subdomain.trim()} onClick={() => void checkHold()}>{t('ui.sites.subdomain_check_hold')}</button>
              {hold?.kind === 'held_you' ? <button type="button" className="button button--secondary" onClick={() => void releaseHold()}>{t('ui.sites.subdomain_release')}</button> : null}
            </div>
            {hold ? (
              <p style={{ margin: 0 }} role="status">
                {hold.kind === 'held_you'
                  ? t('ui.sites.subdomain_held_you', { time: dt(hold.expiresAt) })
                  : hold.kind === 'held_other'
                    ? t('ui.sites.subdomain_held_other')
                    : hold.kind === 'taken'
                      ? t('ui.sites.subdomain_taken')
                      : hold.kind === 'reserved'
                        ? t('ui.setup.subdomain_reserved')
                        : t('ui.sites.subdomain_invalid')}
              </p>
            ) : null}
            <p className="muted" style={{ margin: 0 }}>{t('ui.sites.subdomain_hold_note')}</p>
          </div>
          <label className="field"><span>{t('ui.sites.demo_session')}</span><input className="input mono" value={demoSessionId} onChange={(e) => setDemoSessionId(e.target.value)} placeholder={t('ui.sites.demo_session_hint')} /></label>
          {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
          <div className="row"><button className="button" type="submit" disabled={busy || !entitlementId}>{t('ui.sites.create')}</button></div>
        </form>
      )}
    </div>
  );
}
