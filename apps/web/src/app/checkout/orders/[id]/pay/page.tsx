'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order { id: string; payment_status: string; total_minor: string; currency: string }

function Pay() {
  const { t, locale } = useT();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [ref, setRef] = useState<string | null>(null);
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
        const res = await api<{ provider_ref: string }>(`/orders/${id}/payment-sessions`, { method: 'POST' });
        if (res.ok) setRef(res.data.provider_ref);
        else setError(res.error);
      }
    })();
  }, [id, loadOrder]);

  async function confirmSandbox() {
    if (!ref) return;
    setBusy(true); setError(null);
    // Sandbox only: ask the mock provider to settle, then poll the server for the verified result.
    const res = await api(`/payments/mock/${ref}/confirm`, { method: 'POST', body: {} });
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
        <button type="button" className="button" disabled={busy || !ref} onClick={() => void confirmSandbox()}>{busy ? t('ui.checkout.verifying') : t('ui.checkout.pay_sandbox')}</button>
        <button type="button" className="button button--secondary" onClick={() => void loadOrder()}>{t('ui.checkout.check_status')}</button>
      </div>
      <p className="field__hint">{t('ui.checkout.verify_note')}</p>
    </div>
  );
}

export default function PayPage() {
  return <AuthGate>{() => <Pay />}</AuthGate>;
}
