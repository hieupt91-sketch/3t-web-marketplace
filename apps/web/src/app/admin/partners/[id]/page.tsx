'use client';

import { use, useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface Entry { id: string; kind: string; amount_minor: string; balance_after_minor: string; note: string; created_at: string }
interface Topup { id: string; amount_minor: string; code: string; status: string; created_at: string }
interface Sale { id: string; external_reference: string; listed_minor: string; cut_bps: number; cost_minor: string; price_minor: string; status: string; created_at: string }
interface WalletData { balance_minor: string; entries: Entry[]; topups: Topup[]; sales: Sale[] }

const money = (amount: string, locale: 'vi' | 'en') => formatMoney({ amount_minor: amount, currency: 'VND' }, locale);

function AdminPartnerWalletInner({ id }: { id: string }) {
  const { t, locale } = useT();
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<WalletData>(`/admin/partners/${id}/wallet`);
    if (!res.ok) return setError(res.error);
    setData(res.data);
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;

  async function confirmTopup(topupId: string) {
    if (busy) return;
    setBusy(true);
    const res = await api(`/admin/partners/${id}/wallet/topups/${topupId}/confirm`, { method: 'POST', body: {} });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    void load();
  }

  async function adjust(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaved(false);
    const res = await api(`/admin/partners/${id}/wallet/adjust`, { method: 'POST', body: { amount_minor: adjustAmount, note: adjustNote } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    setAdjustAmount('');
    setAdjustNote('');
    void load();
  }

  return (
    <div className="stack">
      <h1>{t('ui.partner.wallet')}</h1>
      <section className="card stack">
        <strong>{t('ui.partner.balance')}: {money(data.balance_minor, locale)}</strong>
        {data.topups.filter((x) => x.status === 'pending').map((x) => (
          <div key={x.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="mono">{x.code}</span><span>{money(x.amount_minor, locale)}</span>
            <button type="button" className="button" disabled={busy} onClick={() => void confirmTopup(x.id)}>{t('ui.admin.wallet_confirm_topup')}</button>
          </div>
        ))}
      </section>
      <section className="card stack">
        <strong>{t('ui.admin.wallet_adjust')}</strong>
        {saved ? <Alert tone="success"><p>{t('ui.admin.storage.saved')}</p></Alert> : null}
        <form className="stack" onSubmit={adjust}>
          <label className="field"><span>{t('ui.admin.wallet_adjust_amount')}</span>
            <input className="input" type="number" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} disabled={busy} /></label>
          <label className="field"><span>{t('ui.admin.wallet_adjust_note')}</span>
            <input className="input" type="text" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} disabled={busy} /></label>
          <div className="row"><button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button></div>
        </form>
      </section>
      <section className="card stack">
        <strong>{t('ui.partner.wallet_history')}</strong>
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.wallet_kind_label')}</th><th>{t('ui.partner.topup_amount')}</th><th>{t('ui.partner.balance')}</th></tr></thead>
          <tbody>{data.entries.map((r) => (<tr key={r.id}><td>{r.kind}{r.note ? ` · ${r.note}` : ''}</td><td>{money(r.amount_minor, locale)}</td><td>{money(r.balance_after_minor, locale)}</td></tr>))}</tbody></table></div>
      </section>
      <section className="card stack">
        <strong>{t('ui.admin.wallet_sales')}</strong>
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.topup_code')}</th><th>{t('ui.partner.price_listed')}</th><th>{t('ui.partner.price_cost')}</th><th>{t('ui.partner.price_mine')}</th><th>{t('ui.partner.status')}</th></tr></thead>
          <tbody>{data.sales.map((r) => (<tr key={r.id}><td className="mono">{r.external_reference}</td><td>{money(r.listed_minor, locale)}</td><td>{money(r.cost_minor, locale)}</td><td>{money(r.price_minor, locale)}</td><td>{r.status}</td></tr>))}</tbody></table></div>
      </section>
      {error ? <ErrorState error={error} /> : null}
    </div>
  );
}

export default function AdminPartnerWalletPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="partner:read"><AdminPartnerWalletInner id={id} /></RequirePermission>;
}
