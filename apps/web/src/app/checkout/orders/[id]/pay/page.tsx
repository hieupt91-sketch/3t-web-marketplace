'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { QrImage } from '@/components/qr-image';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order { id: string; payment_status: string; total_minor: string; currency: string; payment_window_expires_at: string | null }
interface TransferInstructions {
  content_code?: string;
  qr_payload?: string;
  amount_minor: string;
  currency: string;
  bank_name?: string;
  account_number?: string;
  account_holder?: string;
  account_name?: string;
  bank_bin?: string;
  order_code?: number;
  checkout_url?: string;
  paypal_email?: string;
  swift_code?: string;
  amount_usd?: string;
  usd_rate?: number;
}
interface Session {
  provider: string;
  sandbox: boolean;
  provider_ref: string;
  pay_url: string;
  expires_at: string;
  instructions?: TransferInstructions;
}
interface PublicConfig { payment?: { bank_transfer?: boolean; vnpay?: boolean; momo?: boolean; payos?: boolean; paypal?: boolean; usd_transfer?: boolean } }

const METHOD_KEYS: Record<string, { name: string; desc: string }> = {
  bank_transfer: { name: 'ui.checkout.method_bank', desc: 'ui.checkout.method_bank_desc' },
  vnpay: { name: 'ui.checkout.method_vnpay', desc: 'ui.checkout.method_vnpay_desc' },
  momo: { name: 'ui.checkout.method_momo', desc: 'ui.checkout.method_momo_desc' },
  payos: { name: 'ui.checkout.method_payos', desc: 'ui.checkout.method_payos_desc' },
  paypal: { name: 'ui.checkout.method_paypal', desc: 'ui.checkout.method_paypal_desc' },
  usd_transfer: { name: 'ui.checkout.method_usd', desc: 'ui.checkout.method_usd_desc' },
};

const MANUAL_PROVIDERS = ['bank_transfer', 'paypal', 'usd_transfer'];

function Pay() {
  const { t, dt, locale } = useT();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [methods, setMethods] = useState<string[] | null>(null);
  const [chosenMethod, setChosenMethod] = useState<string>('');
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

  const startSession = useCallback(async (provider?: string) => {
    const res = await api<Session>(`/orders/${id}/payment-sessions`, { method: 'POST', body: provider ? { provider } : {} });
    if (!res.ok) {
      // The 15-minute window just lapsed: the server expired the order;
      // reloading it flips this page to the clear expired state.
      if (res.error.code === 'order.payment_expired') { setError(null); void loadOrder(); return; }
      setError(res.error);
      return;
    }
    setSession(res.data);
  }, [id, loadOrder]);

  useEffect(() => {
    void (async () => {
      const o = await loadOrder();
      if (!o || o.payment_status !== 'awaiting_payment' || sessionStarted.current) return;
      sessionStarted.current = true;
      const cfg = await api<PublicConfig>('/config/public');
      const p = cfg.ok ? cfg.data.payment ?? {} : {};
      const available = [
        ...(p.bank_transfer ? ['bank_transfer'] : []),
        ...(p.vnpay ? ['vnpay'] : []),
        ...(p.momo ? ['momo'] : []),
        ...(p.payos ? ['payos'] : []),
        ...(p.paypal ? ['paypal'] : []),
        ...(p.usd_transfer ? ['usd_transfer'] : []),
      ];
      if (available.length > 1) {
        setMethods(available);
        setChosenMethod(available[0]!);
      } else {
        await startSession(available[0]);
      }
    })();
  }, [id, loadOrder, startSession]);

  // Manual transfers settle server-side (hub report or staff
  // confirmation); poll quietly so the buyer lands on the result page
  // once the settlement lands.
  const transferPending = session !== null && (MANUAL_PROVIDERS.includes(session.provider) || session.provider === 'vnpay' || session.provider === 'momo' || session.provider === 'payos') && order?.payment_status === 'awaiting_payment';
  useEffect(() => {
    if (!transferPending) return;
    const timer = setInterval(() => { void loadOrder(); }, 10_000);
    return () => clearInterval(timer);
  }, [transferPending, loadOrder]);

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const zeroFired = useRef(false);
  useEffect(() => {
    const exp = order?.payment_window_expires_at;
    if (!exp || order?.payment_status !== 'awaiting_payment') { setSecondsLeft(null); return; }
    const target = new Date(exp).getTime();
    const tick = () => setSecondsLeft(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [order?.payment_window_expires_at, order?.payment_status]);
  useEffect(() => {
    if (secondsLeft === 0 && !zeroFired.current) { zeroFired.current = true; void loadOrder(); }
  }, [secondsLeft, loadOrder]);
  const countdownNote = secondsLeft !== null && order?.payment_status === 'awaiting_payment' ? (
    <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.time_left', { time: `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` })}</p>
  ) : null;

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
    if (order.payment_status === 'expired' || order.payment_status === 'cancelled') {
      return (
        <div className="stack">
          <h1>{t('ui.checkout.expired_title')}</h1>
          <Alert tone="warning"><p>{t('ui.checkout.expired_body')}</p></Alert>
          <div className="row">
            <Link className="button" href={`/${locale}/templates`}>{t('ui.checkout.buy_again')}</Link>
            <Link href={`/checkout/orders/${id}/result`}>{t('ui.checkout.see_result')}</Link>
          </div>
        </div>
      );
    }
    if (order.payment_status === 'needs_reconciliation') {
      return <Alert tone="warning"><p>{t('ui.checkout.reconciliation_body')}</p><p><a className="button" href={`/checkout/orders/${id}/result`}>{t('ui.checkout.see_result')}</a></p></Alert>;
    }
    return <Alert tone="info"><p>{t('ui.checkout.not_payable')}</p><p><a className="button" href={`/checkout/orders/${id}/result`}>{t('ui.checkout.see_result')}</a></p></Alert>;
  }

  if (!session && methods) {
    return (
      <div className="stack">
        <h1>{t('ui.checkout.method_title')}</h1>
        <div className="card stack">
          <dl className="details">
            <dt>{t('ui.checkout.order_id')}</dt><dd className="mono">{order.id}</dd>
            <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: order.total_minor, currency: order.currency }, locale)}</strong></dd>
          </dl>
          <fieldset>
            <div className="stack">
              {methods.map((m) => (
                <label key={m} className="row">
                  <input type="radio" name="pay-method" checked={chosenMethod === m} onChange={() => setChosenMethod(m)} />
                  <span><strong>{t(METHOD_KEYS[m]!.name)}</strong> — {t(METHOD_KEYS[m]!.desc)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {countdownNote}
          {error ? <ErrorState error={error} /> : null}
          <div className="row">
            <button type="button" className="button" disabled={busy || !chosenMethod} onClick={() => { setBusy(true); void startSession(chosenMethod).then(() => setBusy(false)); }}>
              {t('ui.checkout.method_continue')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!session) return <Loading />;

  if (session.provider === 'vnpay' || session.provider === 'momo' || session.provider === 'payos') {
    // MoMo and payOS both answer with their own scannable QR payload
    // (MoMo's wallet code, payOS's per-order VietQR); VNPay's QR encodes
    // the hosted pay URL instead.
    const gatewayQr = session.provider === 'momo' || session.provider === 'payos' ? session.instructions?.qr_payload : undefined;
    const qrHint = session.provider === 'momo' ? 'ui.checkout.qr_momo_hint' : session.provider === 'payos' ? 'ui.checkout.qr_bank_hint' : 'ui.checkout.qr_gateway_hint';
    return (
      <div className="stack">
        <h1>{t(METHOD_KEYS[session.provider]!.name)}</h1>
        <div className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <QrImage payload={gatewayQr ?? session.pay_url} />
          <p className="muted" style={{ margin: 0 }}>{t(qrHint)}</p>
        </div>
        {countdownNote}
        <div className="row">
          <a className="button" href={session.pay_url}>{t('ui.checkout.gateway_continue')}</a>
          <button type="button" className="button button--secondary" onClick={() => void loadOrder()}>{t('ui.checkout.check_status')}</button>
        </div>
        <Alert tone="info"><p>{t('ui.checkout.redirecting_note')}</p></Alert>
        {error ? <ErrorState error={error} /> : null}
      </div>
    );
  }

  if (session.provider === 'bank_transfer' && session.instructions) {
    const ins = session.instructions;
    return (
      <div className="stack">
        <h1>{t('ui.checkout.transfer_title')}</h1>
        <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.transfer_intro')}</p>
        {ins.qr_payload ? (
          <div className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <QrImage payload={ins.qr_payload} />
            <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.qr_bank_hint')}</p>
          </div>
        ) : null}
        {countdownNote}
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

  if (session.provider === 'paypal' && session.instructions) {
    const ins = session.instructions;
    return (
      <div className="stack">
        <h1>{t('ui.checkout.paypal_title')}</h1>
        <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.paypal_intro')}</p>
        <div className="card stack">
          <dl className="details">
            <dt>{t('ui.checkout.paypal_email')}</dt><dd className="mono"><strong>{ins.paypal_email}</strong></dd>
            {ins.account_holder ? <><dt>{t('ui.checkout.transfer_account_holder')}</dt><dd>{ins.account_holder}</dd></> : null}
            <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: ins.amount_minor, currency: ins.currency }, locale)}</strong></dd>
            <dt>{t('ui.checkout.transfer_content')}</dt><dd className="mono"><strong>{ins.content_code}</strong></dd>
            <dt>{t('ui.checkout.transfer_expires')}</dt><dd>{dt(session.expires_at)}</dd>
          </dl>
        </div>
        <Alert tone="info"><p>{t('ui.checkout.paypal_note')}</p></Alert>
        {error ? <ErrorState error={error} /> : null}
        <div className="row">
          <button type="button" className="button" onClick={() => void loadOrder()}>{t('ui.checkout.check_status')}</button>
        </div>
      </div>
    );
  }

  if (session.provider === 'usd_transfer' && session.instructions) {
    const ins = session.instructions;
    return (
      <div className="stack">
        <h1>{t('ui.checkout.usd_title')}</h1>
        <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.usd_intro')}</p>
        <div className="card stack">
          <dl className="details">
            <dt>{t('ui.checkout.transfer_bank')}</dt><dd>{ins.bank_name}</dd>
            <dt>{t('ui.checkout.transfer_account_number')}</dt><dd className="mono"><strong>{ins.account_number}</strong></dd>
            <dt>{t('ui.checkout.transfer_account_holder')}</dt><dd>{ins.account_holder}</dd>
            {ins.swift_code ? <><dt>{t('ui.checkout.usd_swift')}</dt><dd className="mono">{ins.swift_code}</dd></> : null}
            <dt>{t('ui.checkout.usd_amount')}</dt><dd className="tabular"><strong>${ins.amount_usd}</strong></dd>
            <dt>{t('ui.checkout.total')}</dt><dd className="tabular">{formatMoney({ amount_minor: ins.amount_minor, currency: ins.currency }, locale)}</dd>
            <dt>{t('ui.checkout.transfer_content')}</dt><dd className="mono"><strong>{ins.content_code}</strong></dd>
            <dt>{t('ui.checkout.transfer_expires')}</dt><dd>{dt(session.expires_at)}</dd>
          </dl>
          {ins.usd_rate ? <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.usd_rate', { rate: ins.usd_rate.toLocaleString(locale) })}</p> : null}
        </div>
        <Alert tone="info"><p>{t('ui.checkout.usd_note')}</p></Alert>
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
