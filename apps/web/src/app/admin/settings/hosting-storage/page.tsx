'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Rates { per_gb_minor: number | null }

/** Storage-priced hosting (v33): the owner sets ONE price for 1 GB per
 *  month. Buyers pick GB and a monthly/yearly period; the total
 *  multiplies automatically (a year = 12 months). Empty = the plan's
 *  flat price applies as before. */
function HostingStorageInner() {
  const { t } = useT();
  const [rates, setRates] = useState<Rates | null>(null);
  const [monthly, setMonthly] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Rates>('/admin/settings/hosting-storage').then((res) => {
      if (res.ok) {
        setRates(res.data);
        setMonthly(res.data.per_gb_minor === null ? '' : String(res.data.per_gb_minor));
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
    const per_gb_minor = parse(monthly);
    if (per_gb_minor === undefined) {
      setFormError(true);
      return;
    }
    setBusy(true);
    const res = await api<Rates>('/admin/settings/hosting-storage', { method: 'POST', body: { per_gb_minor } });
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
