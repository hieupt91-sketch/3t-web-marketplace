'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order { id: string; payment_status: string; total_minor: string; currency: string }
interface TransferInstructions {
  bank_name: string;
  account_number: string;
  account_holder: string;
  content_code: string;
  amount_minor: string;
  currency: string;
}
interface Session {
  provider: string;
  sandbox: boolean;
  provider_ref: string;
  expires_at: string;
  instructions?: TransferInstructions;
}

function Pay() {
  const { t, dt, locale } = useT();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionStarted = useRef(false);

  const loadOrder = useCallback(async () => {
    const res = await api<Order>(`/orders/${id}`);
    if (!res.ok) { setError(res.error); return null; }
    setOrder(res.data);
    if (res.data.payment_status === 'paid') router.replace(`/checkout/orders/${id}/result`);
    return res.data;
  }, [id, router]);

  useEffect(() => {
    void (async () => {
      const o = await loadOrder();
      if (o && o.payment_status === 'awaiting_payment' && !sessionStarted.current) {
        sessionStarted.current = true;
        const res = await api<Session>(`/orders/${id}/payment-sessions`, { method: 'POST', body: {} });
        if (res.ok) setSession(res.data);
        else setError(res.error);
      }
    })();
  }, [id, loadOrder]);

  // Bank transfer settles server-side (hub report or staff confirmation);
  // poll quietly so the buyer lands on the result page once it lands.
  const transferPending = session?.provider === 'bank_transfer' && order?.payment_status === 'awaiting_payment';
  useEffect(() => {
    if (!transferPending) return;
    const timer = setInterval(() => { void loadOrder(); }, 10_000);
    return () => clearInterval(timer);
  }, [transferPending, loadOrder]);

  async function confirmSandbox() {
    if (!session) return;
    setBusy(true); setError(null);
    // Sandbox only: ask the mock provider to settle, then poll the server for the verified result.
    const res = await api(`/payments/mock/${session.provider_ref}/confirm`, { method: 'POST', body: {} });
    if (!res.ok) { setBusy(false); return setError(res.error); }
    for (let i = 0; i < 10; i++) {
      const o = await loadOrder();
      if (o && o.payment_status !== 'awaiting_payment') break;
      await new Promise((r) => setTimeout(r, 400));
    }
    setBusy(false);
  }

  if (error && !order) return <ErrorState error={error} onRetry={() => void loadOrder()} />;
  if (!order) return <Loading />;
  if (order.payment_status !== 'awaiting_payment') {
    return <Alert tone="info"><p>{t('ui.checkout.not_payable')}</p><p><a className="button" href={`/checkout/orders/${id}/result`}>{t('ui.checkout.see_result')}</a></p></Alert>;
  }

  if (session?.provider === 'bank_transfer' && session.instructions) {
    const ins = session.instructions;
    return (
      <div className="stack">
        <h1>{t('ui.checkout.transfer_title')}</h1>
        <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.transfer_intro')}</p>
        <div className="card stack">
          <dl className="details">
            <dt>{t('ui.checkout.transfer_bank')}</dt><dd>{ins.bank_name}</dd>
            <dt>{t('ui.checkout.transfer_account_number')}</dt><dd className="mono"><strong>{ins.account_number}</strong></dd>
            <dt>{t('ui.checkout.transfer_account_holder')}</dt><dd>{ins.account_holder}</dd>
            <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: ins.amount_minor, currency: ins.currency }, locale)}</strong></dd>
            <dt>{t('ui.checkout.transfer_content')}</dt><dd className="mono"><strong>{ins.content_code}</strong></dd>
            <dt>{t('ui.checkout.transfer_expires')}</dt><dd>{dt(session.expires_at)}</dd>
          </dl>
        </div>
        <Alert tone="info"><p>{t('ui.checkout.transfer_note')}</p></Alert>
        {error ? <ErrorState error={error} /> : null}
        <div className="row">
          <button type="button" className="button" onClick={() => void loadOrder()}>{t('ui.checkout.check_status')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>{t('ui.checkout.pay_title')}</h1>
      <Alert tone="warning"><p><strong>{t('ui.checkout.sandbox_badge')}</strong> {t('ui.checkout.sandbox_note')}</p></Alert>
      <div className="card stack">
        <dl className="details">
          <dt>{t('ui.checkout.order_id')}</dt><dd className="mono">{order.id}</dd>
          <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: order.total_minor, currency: order.currency }, locale)}</strong></dd>
        </dl>
      </div>
      {error ? <ErrorState error={error} /> : null}
      <div className="row">
        <button type="button" className="button" disabled={busy || !session} onClick={() => void confirmSandbox()}>{busy ? t('ui.checkout.verifying') : t('ui.checkout.pay_sandbox')}</button>
        <button type="button" className="button button--secondary" onClick={() => void loadOrder()}>{t('ui.checkout.check_status')}</button>
      </div>
      <p className="field__hint">{t('ui.checkout.verify_note')}</p>
    </div>
  );
}

export default function PayPage() {
  return <AuthGate>{() => <Pay />}</AuthGate>;
}
