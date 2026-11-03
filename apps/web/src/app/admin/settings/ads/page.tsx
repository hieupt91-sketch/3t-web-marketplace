'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface AdSide {
  image_url: string;
  link_url: string;
  alt: string;
}

interface AdsSettings {
  enabled: boolean;
  left: AdSide;
  right: AdSide;
}

const EMPTY: AdSide = { image_url: '', link_url: '', alt: '' };

function SideFields({ label, side, onChange, busy }: { label: string; side: AdSide; onChange: (next: AdSide) => void; busy: boolean }) {
  const { t } = useT();
  const set = (patch: Partial<AdSide>) => onChange({ ...side, ...patch });
  return (
    <fieldset className="stack">
      <legend>{label}</legend>
      <label className="field">
        <span>{t('ui.ads_settings.image_url')}</span>
        <input className="input" value={side.image_url} onChange={(e) => set({ image_url: e.target.value })} disabled={busy} autoComplete="off" placeholder="https://…" />
      </label>
      <label className="field">
        <span>{t('ui.ads_settings.link_url')}</span>
        <input className="input" value={side.link_url} onChange={(e) => set({ link_url: e.target.value })} disabled={busy} autoComplete="off" placeholder="https://…" />
      </label>
      <label className="field">
        <span>{t('ui.ads_settings.alt')}</span>
        <input className="input" value={side.alt} onChange={(e) => set({ alt: e.target.value })} disabled={busy} autoComplete="off" />
      </label>
      {side.image_url.trim() !== '' ? (
        <p style={{ margin: 0 }}>
          <img src={side.image_url} alt={side.alt} width={160} height={600} style={{ width: 120, height: 'auto', borderRadius: 8, border: '1px solid var(--color-border)' }} />
        </p>
      ) : null}
    </fieldset>
  );
}

/** Side-rail advertising slots for the wide empty margins of the
 *  storefront. A rail renders only when ads are enabled here AND that
 *  side has an image URL; everything empty stays invisible. */
function AdsSettingsInner() {
  const { t } = useT();
  const [settings, setSettings] = useState<AdsSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [left, setLeft] = useState<AdSide>(EMPTY);
  const [right, setRight] = useState<AdSide>(EMPTY);
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<AdsSettings>('/admin/settings/ads').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setLeft(res.data.left);
        setRight(res.data.right);
      } else setError(res.error);
    });
  }, []);

  const urlOk = (v: string) => {
    const s = v.trim();
    if (s === '') return true;
    // Site-relative only as a single `/` not followed by `/` or `\` —
    // `/\evil.com` is protocol-relative too (UI-LOW-01 family).
    if (s.startsWith('/')) return s[1] !== '/' && s[1] !== '\\';
    try {
      const u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false);
    setSaved(false);
    setError(null);
    const bad = [left, right].some(
      (s) => !urlOk(s.image_url) || !urlOk(s.link_url) || (s.link_url.trim() !== '' && s.image_url.trim() === ''),
    );
    if (bad) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const res = await api<AdsSettings>('/admin/settings/ads', { method: 'POST', body: { enabled, left, right } });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setSettings(res.data);
      setSaved(true);
    }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.ads_settings.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.ads_settings.hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.ads_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.ads_settings.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
          <span>{t('ui.ads_settings.enabled')}</span>
        </label>
        <SideFields label={t('ui.ads_settings.left')} side={left} onChange={setLeft} busy={busy} />
        <SideFields label={t('ui.ads_settings.right')} side={right} onChange={setRight} busy={busy} />
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function AdsSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <AdsSettingsInner />
    </RequirePermission>
  );
}
