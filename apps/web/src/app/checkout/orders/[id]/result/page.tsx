'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Order { id: string; payment_status: string }

function Result() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { void api<Order>(`/orders/${id}`).then((r) => (r.ok ? setOrder(r.data) : setError(r.error))); }, [id]);
  if (error && !order) return <ErrorState error={error} />;
  if (!order) return <Loading />;
  const paid = order.payment_status === 'paid';
  return (
    <div className="stack">
      <h1>{t('ui.checkout.result_title')}</h1>
      <div><StatusBadge tone={paid ? 'success' : order.payment_status === 'needs_reconciliation' ? 'warning' : 'neutral'}>{t(`ui.order_status.${order.payment_status}`)}</StatusBadge></div>
      {paid ? (
        <Alert tone="success"><p>{t('ui.checkout.paid_body')}</p><p><Link className="button" href="/account/purchases">{t('ui.account.nav.purchases')}</Link></p></Alert>
      ) : order.payment_status === 'needs_reconciliation' ? (
        <Alert tone="warning"><p>{t('ui.checkout.reconciliation_body')}</p></Alert>
      ) : (
        <Alert tone="info"><p>{t('ui.checkout.pending_body')}</p><p><Link href={`/checkout/orders/${id}/pay`}>{t('ui.checkout.back_to_pay')}</Link></p></Alert>
      )}
    </div>
  );
}

export default function ResultPage() {
  return <AuthGate>{() => <Result />}</AuthGate>;
}
