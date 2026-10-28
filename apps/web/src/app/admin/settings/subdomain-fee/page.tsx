'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Fee { amount_minor: number | null; period: 'once' | 'monthly' }

/** Owner-set subdomain fee (setup wizard reads it from /config/public).
 *  Empty amount = fee not published yet; the wizard then falls back to
 *  the "fee confirmed at handover" note. A set fee must be a positive
 *  integer in the platform currency's minor units. */
function SubdomainFeeInner() {
  const { t } = useT();
  const [fee, setFee] = useState<Fee | null>(null);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<'once' | 'monthly'>('once');
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Fee>('/admin/settings/subdomain-fee').then((res) => {
      if (res.ok) {
        setFee(res.data);
        setAmount(res.data.amount_minor === null ? '' : String(res.data.amount_minor));
        setPeriod(res.data.period);
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
    setBusy(true);
    const res = await api<Fee>('/admin/settings/subdomain-fee', { method: 'POST', body: { amount_minor, period } });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setFee(res.data);
      setSaved(true);
    }
  }

  if (error && !fee) return <ErrorState error={error} />;
  if (!fee) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.subdomain_fee.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.subdomain_fee.hint')}</p>
      <p className="muted" style={{ margin: 0 }}>{t('ui.subdomain_fee.unset_note')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.subdomain_fee.saved')}</p></Alert> : null}
      {formError ? <Alert tone="error"><p>{t('ui.subdomain_fee.invalid')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        <label className="field">
          <span>{t('ui.subdomain_fee.amount')}</span>
          <input
            className="input"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </label>
        <fieldset>
          <legend>{t('ui.subdomain_fee.period')}</legend>
          <div className="row">
            <label className="row">
              <input type="radio" name="fee-period" checked={period === 'once'} onChange={() => setPeriod('once')} disabled={busy} />
              <span>{t('ui.subdomain_fee.period_once')}</span>
            </label>
            <label className="row">
              <input type="radio" name="fee-period" checked={period === 'monthly'} onChange={() => setPeriod('monthly')} disabled={busy} />
              <span>{t('ui.subdomain_fee.period_monthly')}</span>
            </label>
          </div>
        </fieldset>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function SubdomainFeeSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <SubdomainFeeInner />
    </RequirePermission>
  );
}
