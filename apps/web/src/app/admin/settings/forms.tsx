'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError, type ApiResult } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useStepUp } from './step-up';

interface MailSettings {
  enabled: boolean;
  api_key_configured: boolean;
  from_address: string;
  from_name: string;
}

/** Outbound email via Resend (verification + password-reset mail). The
 *  API key is write-only: the server never returns it, so the form only
 *  sends a key when the owner types a new one; leaving it blank keeps
 *  the configured key — the same contract as the payment secrets. */
export function MailForm() {
  const { t } = useT();
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [testFailed, setTestFailed] = useState(false);

  useEffect(() => {
    void api<MailSettings>('/admin/settings/mail').then((res) => {
      if (res.ok) {
        setSettings(res.data);
        setEnabled(res.data.enabled);
        setFromAddress(res.data.from_address);
        setFromName(res.data.from_name);
      } else setError(res.error);
    });
  }, []);

  const doSave = async (): Promise<ApiResult<MailSettings>> => {
    const body: Record<string, unknown> = { enabled, from_address: fromAddress, from_name: fromName };
    if (apiKey.trim() !== '') body.api_key = apiKey.trim();
    return api<MailSettings>('/admin/settings/mail', { method: 'POST', body });
  };
  const saveStepUp = useStepUp(doSave);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false); setSaved(false); setError(null);
    if (enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress.trim())) { setFormError(true); return; }
    if (enabled && !settings?.api_key_configured && apiKey.trim() === '') { setFormError(true); return; }
    setBusy(true);
    const res = await saveStepUp.submit();
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setSettings(res.data); setApiKey(''); setSaved(true); }
  }

  const doTest = async (): Promise<ApiResult<{ sent: boolean }>> =>
    api<{ sent: boolean }>('/admin/settings/mail/test', { method: 'POST', body: { to: testTo.trim() } });
  const testStepUp = useStepUp(doTest);

  async function sendTest(event: FormEvent) {
    event.preventDefault();
    if (testBusy) return;
    setTestSent(false); setTestFailed(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo.trim())) { setTestFailed(true); return; }
    setTestBusy(true);
    const res = await testStepUp.submit();
    setTestBusy(false);
    if (res.ok) setTestSent(true);
    else setTestFailed(true);
  }

  if (error && !settings) return <ErrorState error={error} />;
  if (!settings) return <Loading />;
  return (
    <div className="stack">
      <form className="stack card" onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t('ui.mail_settings.title')}</h2>
          <span className={`status-pill${settings.enabled ? ' status-pill--on' : ''}`}>{settings.enabled ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>{t('ui.mail_settings.hint')}</p>
        {saved ? <Alert tone="success"><p>{t('ui.mail_settings.saved')}</p></Alert> : null}
        {formError ? <Alert tone="error"><p>{t('ui.mail_settings.invalid')}</p></Alert> : null}
        {error ? <ErrorState error={error} /> : null}
        {saveStepUp.prompt}
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
          <span>{t('ui.mail_settings.enabled')}</span>
        </label>
        <label className="field">
          <span>{t('ui.mail_settings.from_address')}</span>
          <input className="input" type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} disabled={busy} autoComplete="off" placeholder="no-reply@webmaket.com" />
        </label>
        <label className="field">
          <span>{t('ui.mail_settings.from_name')}</span>
          <input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={busy} autoComplete="off" placeholder="webmaket" />
        </label>
        <label className="field">
          <span>{t('ui.mail_settings.api_key')}</span>
          <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} autoComplete="off" placeholder={t('ui.mail_settings.api_key_hint')} />
        </label>
        <p className="muted" style={{ margin: 0 }}>{settings.api_key_configured ? t('ui.mail_settings.key_configured') : t('ui.mail_settings.key_missing')}</p>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>

      <form className="stack card" onSubmit={sendTest}>
        <h2 style={{ margin: 0 }}>{t('ui.mail_settings.test_title')}</h2>
        <p className="muted" style={{ margin: 0 }}>{t('ui.mail_settings.test_hint')}</p>
        {testSent ? <Alert tone="success"><p>{t('ui.mail_settings.test_sent')}</p></Alert> : null}
        {testFailed ? <Alert tone="error"><p>{t('ui.mail_settings.test_failed')}</p></Alert> : null}
        {testStepUp.prompt}
        <label className="field">
          <span>{t('ui.mail_settings.test_to')}</span>
          <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} disabled={testBusy} autoComplete="off" />
        </label>
        <div className="row">
          <button type="submit" className="button button--secondary" disabled={testBusy}>{t('ui.mail_settings.test_send')}</button>
        </div>
      </form>
    </div>
  );
}
