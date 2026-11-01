'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Rates { monthly_per_gb: number | null; yearly_per_gb: number | null }

/** Storage-priced hosting: the owner prices 1 GB per period; buyers pick
 *  how many GB they need and pay rate x GB. An empty period falls back
 *  to the plan's flat price. */
function HostingStorageInner() {
  const { t } = useT();
  const [rates, setRates] = useState<Rates | null>(null);
  const [monthly, setMonthly] = useState('');
  const [yearly, setYearly] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Rates>('/admin/settings/hosting-storage').then((res) => {
      if (res.ok) {
        setRates(res.data);
        setMonthly(res.data.monthly_per_gb === null ? '' : String(res.data.monthly_per_gb));
        setYearly(res.data.yearly_per_gb === null ? '' : String(res.data.yearly_per_gb));
      } else setError(res.error);
    });
  }, []);

  function parse(v: string): number | null | undefined {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(false);
    setSaved(false);
    setError(null);
    const monthly_per_gb = parse(monthly);
    const yearly_per_gb = parse(yearly);
    if (monthly_per_gb === undefined || yearly_per_gb === undefined) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const res = await api<Rates>('/admin/settings/hosting-storage', { method: 'POST', body: { monthly_per_gb, yearly_per_gb } });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setRates(res.data);
      setSaved(true);
    }
  }

  if (error && !rates) return <ErrorState error={error} />;
  if (!rates) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.admin.storage.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.admin.storage.hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.admin.storage.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.admin.storage.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        <label className="field">
          <span>{t('ui.admin.storage.monthly')}</span>
          <input className="input" type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <label className="field">
          <span>{t('ui.admin.storage.yearly')}</span>
          <input className="input" type="number" value={yearly} onChange={(e) => setYearly(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function HostingStorageSettingsPage() {
  return <RequirePermission permission="settings:manage"><HostingStorageInner /></RequirePermission>;
}
