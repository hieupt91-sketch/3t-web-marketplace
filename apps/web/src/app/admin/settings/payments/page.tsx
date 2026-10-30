'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface PaymentSettings {
  enabled: boolean;
  bank_name: string;
  account_number: string;
  account_holder: string;
  hub_configured: boolean;
  webhook_url: string;
}

/** Owner-set bank transfer payments. The hub API key is write-only: the
 *  server never returns it, so this form only ever sends a new key when
 *  the owner types one; leaving it blank keeps the configured key. */
function PaymentSettingsInner() {
  const { t } = useT();
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [hubKey, setHubKey] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<PaymentSettings>('/admin/settings/payment').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setBankName(res.data.bank_name);
        setAccountNumber(res.data.account_number);
        setAccountHolder(res.data.account_holder);
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false);
    setSaved(false);
    setError(null);
    if (enabled && (!bankName.trim() || !/^[0-9]{6,30}$/.test(accountNumber.replace(/\s+/g, '')) || !accountHolder.trim())) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = {
      enabled,
      bank_name: bankName,
      account_number: accountNumber,
      account_holder: accountHolder,
    };
    if (hubKey.trim() !== '') body.hub_api_key = hubKey.trim();
    const res = await api<PaymentSettings>('/admin/settings/payment', { method: 'POST', body });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setSettings(res.data);
      setHubKey('');
      setSaved(true);
    }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.payment_settings.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.payment_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.payment_settings.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
          <span>{t('ui.payment_settings.enabled')}</span>
        </label>
        <label className="field">
          <span>{t('ui.payment_settings.bank_name')}</span>
          <input className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <label className="field">
          <span>{t('ui.payment_settings.account_number')}</span>
          <input className="input" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} disabled={busy} autoComplete="off" inputMode="numeric" />
        </label>
        <label className="field">
          <span>{t('ui.payment_settings.account_holder')}</span>
          <input className="input" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <fieldset>
          <legend>{t('ui.payment_settings.hub_title')}</legend>
          <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.hub_hint')}</p>
          <dl className="details">
            <dt>{t('ui.payment_settings.webhook_url')}</dt>
            <dd className="mono">{settings.webhook_url}</dd>
            <dt>{t('ui.payment_settings.hub_status')}</dt>
            <dd>{settings.hub_configured ? t('ui.payment_settings.hub_configured') : t('ui.payment_settings.hub_missing')}</dd>
          </dl>
          <label className="field">
            <span>{t('ui.payment_settings.hub_api_key')}</span>
            <input className="input" type="password" value={hubKey} onChange={(e) => setHubKey(e.target.value)} disabled={busy} autoComplete="new-password" placeholder={t('ui.payment_settings.hub_api_key_hint')} />
          </label>
        </fieldset>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function PaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <PaymentSettingsInner />
    </RequirePermission>
  );
}
