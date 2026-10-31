'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Back link shared by the per-method payment settings pages: each method
 *  has its OWN page (bank / vnpay / momo / paypal / usd) under the payments
 *  settings index — nothing is mixed into one long form page. */
export function PaymentSettingsBackLink() {
  const { t } = useT();
  return (
    <p style={{ margin: 0 }}>
      <Link href="/admin/settings/payments">← {t('ui.payment_settings.title')}</Link>
    </p>
  );
}

interface PaymentSettings {
  enabled: boolean;
  bank_name: string;
  account_number: string;
  account_holder: string;
  hub_configured: boolean;
  webhook_url: string;
  casso_webhook_url: string;
}

/** Owner-set bank transfer payments. The hub API key is write-only: the
 *  server never returns it, so this form only ever sends a new key when
 *  the owner types one; leaving it blank keeps the configured key. */
export function BankTransferForm() {
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
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('ui.checkout.method_bank')}</h1>
        <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
      </div>
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
            <dt>{t('ui.payment_settings.casso_webhook_url')}</dt>
            <dd className="mono">{settings.casso_webhook_url}</dd>
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

interface VnPaySettings {
  enabled: boolean;
  tmn_code: string;
  secret_configured: boolean;
  sandbox: boolean;
  ipn_url: string;
}

export function VnPayForm() {
  const { t } = useT();
  const [settings, setSettings] = useState<VnPaySettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tmnCode, setTmnCode] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<VnPaySettings>('/admin/settings/payment-vnpay').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setTmnCode(res.data.tmn_code);
        setSandbox(res.data.sandbox);
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false); setSaved(false); setError(null);
    if (enabled && (!/^[A-Za-z0-9]{4,30}$/.test(tmnCode.trim()) || (!settings?.secret_configured && secretKey.trim() === ''))) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = { enabled, tmn_code: tmnCode, sandbox };
    if (secretKey.trim() !== '') body.secret_key = secretKey.trim();
    const res = await api<VnPaySettings>('/admin/settings/payment-vnpay', { method: 'POST', body });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setSettings(res.data); setSecretKey(''); setSaved(true); }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;
  return (
    <form className="stack card" onSubmit={submit}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('ui.payment_settings.vnpay_title')}</h2>
        <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.vnpay_hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.payment_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.payment_settings.gateway_invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.vnpay_enabled')}</span>
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.tmn_code')}</span>
        <input className="input" value={tmnCode} onChange={(e) => setTmnCode(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <dl className="details">
        <dt>{t('ui.payment_settings.ipn_url')}</dt>
        <dd className="mono">{settings.ipn_url}</dd>
        <dt>{t('ui.payment_settings.secret_status')}</dt>
        <dd>{settings.secret_configured ? t('ui.payment_settings.hub_configured') : t('ui.payment_settings.hub_missing')}</dd>
      </dl>
      <label className="field">
        <span>{t('ui.payment_settings.secret_key')}</span>
        <input className="input" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} disabled={busy} autoComplete="new-password" placeholder={t('ui.payment_settings.hub_api_key_hint')} />
      </label>
      <label className="row">
        <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.sandbox')}</span>
      </label>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
      </div>
    </form>
  );
}

interface MoMoSettings {
  enabled: boolean;
  partner_code: string;
  access_key: string;
  secret_configured: boolean;
  sandbox: boolean;
  ipn_url: string;
}

export function MoMoForm() {
  const { t } = useT();
  const [settings, setSettings] = useState<MoMoSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [partnerCode, setPartnerCode] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<MoMoSettings>('/admin/settings/payment-momo').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setPartnerCode(res.data.partner_code);
        setAccessKey(res.data.access_key);
        setSandbox(res.data.sandbox);
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false); setSaved(false); setError(null);
    if (enabled && (!partnerCode.trim() || !accessKey.trim() || (!settings?.secret_configured && secretKey.trim() === ''))) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const body: Record<string, unknown> = { enabled, partner_code: partnerCode, access_key: accessKey, sandbox };
    if (secretKey.trim() !== '') body.secret_key = secretKey.trim();
    const res = await api<MoMoSettings>('/admin/settings/payment-momo', { method: 'POST', body });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setSettings(res.data); setSecretKey(''); setSaved(true); }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;
  return (
    <form className="stack card" onSubmit={submit}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('ui.payment_settings.momo_title')}</h2>
        <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.momo_hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.payment_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.payment_settings.gateway_invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.momo_enabled')}</span>
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.partner_code')}</span>
        <input className="input" value={partnerCode} onChange={(e) => setPartnerCode(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.access_key')}</span>
        <input className="input" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <dl className="details">
        <dt>{t('ui.payment_settings.ipn_url')}</dt>
        <dd className="mono">{settings.ipn_url}</dd>
        <dt>{t('ui.payment_settings.secret_status')}</dt>
        <dd>{settings.secret_configured ? t('ui.payment_settings.hub_configured') : t('ui.payment_settings.hub_missing')}</dd>
      </dl>
      <label className="field">
        <span>{t('ui.payment_settings.secret_key')}</span>
        <input className="input" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} disabled={busy} autoComplete="new-password" placeholder={t('ui.payment_settings.hub_api_key_hint')} />
      </label>
      <label className="row">
        <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.sandbox')}</span>
      </label>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
      </div>
    </form>
  );
}

interface PayPalSettings {
  enabled: boolean;
  email: string;
  holder: string;
}

export function PayPalForm() {
  const { t } = useT();
  const [settings, setSettings] = useState<PayPalSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [email, setEmail] = useState('');
  const [holder, setHolder] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<PayPalSettings>('/admin/settings/payment-paypal').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setEmail(res.data.email);
        setHolder(res.data.holder);
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false); setSaved(false); setError(null);
    if (enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormError(true); return; }
    setBusy(true);
    const res = await api<PayPalSettings>('/admin/settings/payment-paypal', { method: 'POST', body: { enabled, email, holder } });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setSettings(res.data); setSaved(true); }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;
  return (
    <form className="stack card" onSubmit={submit}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('ui.payment_settings.paypal_title')}</h2>
        <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.paypal_hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.payment_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.payment_settings.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.paypal_enabled')}</span>
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.paypal_email')}</span>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.paypal_holder')}</span>
        <input className="input" value={holder} onChange={(e) => setHolder(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
      </div>
    </form>
  );
}

interface UsdSettings {
  enabled: boolean;
  bank_name: string;
  account_number: string;
  account_holder: string;
  swift_code: string;
  usd_rate: number;
}

export function UsdForm() {
  const { t } = useT();
  const [settings, setSettings] = useState<UsdSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<UsdSettings>('/admin/settings/payment-usd').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setBankName(res.data.bank_name);
        setAccountNumber(res.data.account_number);
        setAccountHolder(res.data.account_holder);
        setSwiftCode(res.data.swift_code);
        setRate(res.data.usd_rate > 0 ? String(res.data.usd_rate) : '');
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false); setSaved(false); setError(null);
    const rateNum = Number(rate.replace(/[^\d]/g, ''));
    if (enabled && (!bankName.trim() || !accountNumber.trim() || !accountHolder.trim() || !(rateNum > 0))) { setFormError(true); return; }
    setBusy(true);
    const res = await api<UsdSettings>('/admin/settings/payment-usd', {
      method: 'POST',
      body: { enabled, bank_name: bankName, account_number: accountNumber, account_holder: accountHolder, swift_code: swiftCode, usd_rate: rateNum },
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setSettings(res.data); setSaved(true); }
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;
  return (
    <form className="stack card" onSubmit={submit}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('ui.payment_settings.usd_title')}</h2>
        <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.usd_hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.payment_settings.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.payment_settings.usd_invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>{t('ui.payment_settings.usd_enabled')}</span>
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.bank_name')}</span>
        <input className="input" value={bankName} onChange={(e) => setBankName(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.account_number')}</span>
        <input className="input" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.account_holder')}</span>
        <input className="input" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.swift_code')}</span>
        <input className="input" value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('ui.payment_settings.usd_rate')}</span>
        <input className="input" value={rate} onChange={(e) => setRate(e.target.value)} disabled={busy} autoComplete="off" inputMode="numeric" placeholder="26000" />
      </label>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
      </div>
    </form>
  );
}
