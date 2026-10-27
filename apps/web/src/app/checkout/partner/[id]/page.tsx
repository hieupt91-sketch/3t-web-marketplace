'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function PartnerCheckoutInner({ id }: { id: string }) {
  const { t } = useT();
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [status, setStatus] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  async function claim() {
    const res = await api(`/partner/checkout-sessions/${id}/claim`, { method: 'POST', body: { claim_token: token } });
    if (!res.ok) return setError(res.error);
    setStatus('claimed');
  }
  async function order() {
    const res = await api<{ order_id: string }>(`/partner/checkout-sessions/${id}/order`, { method: 'POST', body: {} });
    if (!res.ok) return setError(res.error);
    setOrderId(res.data.order_id);
  }
  return (
    <div className="stack">
      <h1>{t('ui.partner.title')}</h1>
      {error ? <ErrorState error={error} /> : null}
      {status === null ? <button type="button" className="button" onClick={() => void claim()}>claim</button> : null}
      {status === 'claimed' && !orderId ? <button type="button" className="button" onClick={() => void order()}>create order</button> : null}
      {orderId ? <Link className="button" href={`/checkout/orders/${orderId}/pay`}>{t('ui.checkout.issue_pay_again')}</Link> : null}
    </div>
  );
}

export default function PartnerCheckout({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense fallback={<Loading />}><PartnerCheckoutInner id={id} /></Suspense>;
}
