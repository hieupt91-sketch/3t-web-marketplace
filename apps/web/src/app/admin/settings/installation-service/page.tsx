'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Svc { enabled: boolean; amount_minor: number | null }

/** The installation/configuration service package: its OWN settings
 *  (owner separation rule). When enabled with a price, buyers can add it
 *  to a purchase as a separate line; fulfilment creates a service task
 *  for the team. Nothing is ever bundled into the web or hosting price. */
function InstallationInner() {
  const { t } = useT();
  const [svc, setSvc] = useState<Svc | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Svc>('/admin/settings/installation-service').then((res) => {
      if (res.ok) {
        setSvc(res.data);
        setEnabled(res.data.enabled);
        setAmount(res.data.amount_minor === null ? '' : String(res.data.amount_minor));
      } else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false);
    setSaved(false);
    setError(null);
    let amount_minor: number | null = null;
    if (amount.trim() !== '') {
      const n = Number(amount);
      if (!Number.isInteger(n) || n <= 0) {
        setFormError(true);
        return;
      }
      amount_minor = n;
    }
    if (enabled && amount_minor === null) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const res = await api<Svc>('/admin/settings/installation-service', { method: 'POST', body: { enabled, amount_minor } });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setSvc(res.data);
      setSaved(true);
    }
  }

  if (error && !svc) return <ErrorState error={error} />;
  if (!svc) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.admin.installation.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.admin.installation.hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.admin.installation.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.admin.installation.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
          <span>{t('ui.admin.installation.enabled')}</span>
        </label>
        <label className="field">
          <span>{t('ui.admin.installation.amount')}</span>
          <input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function InstallationServiceSettingsPage() {
  return <RequirePermission permission="settings:manage"><InstallationInner /></RequirePermission>;
}
