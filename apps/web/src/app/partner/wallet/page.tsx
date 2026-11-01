'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface Entry { id: string; kind: string; amount_points: string; balance_after_points: string; note: string; created_at: string }
interface Topup { id: string; amount_points: string; transfer_amount_minor: string; code: string; status: string; created_at: string }
interface Wallet { balance_points: string; balance_vnd: string; currency: string; reseller_discount_bps: number; entries: Entry[]; topups: Topup[] }
interface CreatedTopup { id: string; code: string; amount_points: string; transfer_amount_minor: string; bank: { bank_name: string; account_number: string; account_holder: string; content: string; amount_minor: string } | null }

const money = (amount: string, locale: 'vi' | 'en') => formatMoney({ amount_minor: amount, currency: 'VND' }, locale);

export default function PartnerWalletPage() {
  const { t, locale } = useT();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [amount, setAmount] = useState('500');
  const [created, setCreated] = useState<CreatedTopup | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Wallet>('/partner/wallet');
    if (!res.ok) return setError(res.error);
    setWallet(res.data);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !wallet) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!wallet) return <Loading />;

  async function createTopup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setCreated(null);
    const res = await api<CreatedTopup>('/partner/wallet/topups', { method: 'POST', body: { amount_points: amount } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setCreated(res.data);
    void load();
  }

  const KIND_KEYS = { topup: 'ui.partner.wallet_kind.topup', sale_deduction: 'ui.partner.wallet_kind.sale_deduction', sale_refund: 'ui.partner.wallet_kind.sale_refund', adjustment: 'ui.partner.wallet_kind.adjustment' } as const;
  const kindLabel = (kind: string) => t(KIND_KEYS[kind as keyof typeof KIND_KEYS] ?? 'ui.partner.wallet_kind.adjustment');

  return (
    <div className="stack">
      <h1>{t('ui.partner.wallet')}</h1>
      <section className="card stack">
        <strong>{t('ui.partner.balance')}: {wallet.balance_points} {t('ui.partner.points')} <span className="muted">({t('ui.partner.balance_equiv', { amount: money(wallet.balance_vnd, locale) })})</span></strong>
        <p className="muted" style={{ margin: 0 }}>{t('ui.partner.wallet_hint', { pct: String(wallet.reseller_discount_bps / 100) })}</p>
      </section>

      <section className="card stack">
        <strong>{t('ui.partner.topup_title')}</strong>
        <form className="row" onSubmit={createTopup} style={{ alignItems: 'end' }}>
          <label className="field">
            <span>{t('ui.partner.topup_amount')}</span>
            <input className="input" type="number" min={10} step={10} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          </label>
          <button type="submit" className="button" disabled={busy}>{t('ui.partner.topup_create')}</button>
          <span className="muted">{t('ui.partner.topup_equiv', { amount: money(String((Number(amount) || 0) * 1000), locale) })}</span>
        </form>
        {created ? (
          <Alert tone="success">
            {created.bank ? (
              <p>{t('ui.partner.topup_instructions', { amount: money(created.transfer_amount_minor, locale), bank: created.bank.bank_name, account: created.bank.account_number, holder: created.bank.account_holder, code: created.code })}</p>
            ) : (
              <p>{t('ui.partner.topup_no_bank', { code: created.code })}</p>
            )}
          </Alert>
        ) : null}
        {wallet.topups.length > 0 ? (
          <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.topup_code')}</th><th>{t('ui.partner.topup_amount')}</th><th>{t('ui.partner.status')}</th></tr></thead>
            <tbody>{wallet.topups.map((r) => (<tr key={r.id}><td className="mono">{r.code}</td><td>{r.amount_points} {t('ui.partner.points')}</td><td>{r.status}</td></tr>))}</tbody></table></div>
        ) : null}
      </section>

      <section className="card stack">
        <strong>{t('ui.partner.wallet_history')}</strong>
        {wallet.entries.length === 0 ? <EmptyState title={t('ui.partner.wallet_history')}><p>—</p></EmptyState> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.wallet_kind_label')}</th><th>{t('ui.partner.topup_amount')}</th><th>{t('ui.partner.balance')}</th></tr></thead>
            <tbody>{wallet.entries.map((r) => (<tr key={r.id}><td>{kindLabel(r.kind)}{r.note ? ` · ${r.note}` : ''}</td><td>{r.amount_points} {t('ui.partner.points')}</td><td>{r.balance_after_points} {t('ui.partner.points')}</td></tr>))}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
