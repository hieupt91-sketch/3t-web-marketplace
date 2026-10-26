'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
interface Payout { id: string; amount_minor: string; status: string; evidence_ref: string | null; created_at: string }
interface Profile { id: string; account_label: string }

export default function PartnerPayouts() {
  const { t } = useT();
  const [rows, setRows] = useState<Payout[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [amount, setAmount] = useState('');
  const [profileId, setProfileId] = useState('');
  const [label, setLabel] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const [p, pr] = await Promise.all([api<Payout[]>('/partner/payouts'), api<Profile[]>('/partner/payout-profiles')]);
    if (!p.ok) return setError(p.error);
    if (pr.ok) setProfiles(pr.data);
    setRows(p.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function requestPayout(e: React.FormEvent) {
    e.preventDefault();
    const res = await api('/partner/payouts', { method: 'POST', body: { amount_minor: amount, profile_id: profileId } });
    if (!res.ok) return setError(res.error);
    void load();
  }
  async function addProfile(e: React.FormEvent) {
    e.preventDefault();
    const res = await api('/partner/payout-profiles', { method: 'POST', body: { account_label: label } });
    if (!res.ok) return setError(res.error);
    setLabel(''); void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.payouts')}</h1>
      <p>{t('ui.partner.payout_profile_note')}</p>
      {error ? <ErrorState error={error} /> : null}
      <form onSubmit={addProfile} className="stack">
        <label>{t('ui.partner.settings')}<input value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="VCB ••1234" /></label>
        <button className="button button--secondary">{t('ui.partner.settings')}</button>
      </form>
      <form onSubmit={requestPayout} className="stack">
        <label>{t('ui.partner.balance')}<input value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="numeric" placeholder="500000" /></label>
        <label>{t('ui.partner.settings')}<select value={profileId} onChange={(e) => setProfileId(e.target.value)} required><option value="">—</option>{profiles.map((p) => (<option key={p.id} value={p.id}>{p.account_label}</option>))}</select></label>
        <button className="button">{t('ui.partner.payouts')}</button>
      </form>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.payouts')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.balance')}</th><th>{t('ui.partner.status')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.amount_minor}</td><td>{r.status}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
