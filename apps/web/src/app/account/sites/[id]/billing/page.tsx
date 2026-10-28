'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Billing { subscription: { status: string; current_period_start: string; current_period_end: string; policy_snapshot: { period_days: number; grace_days: number; retention_days: number } } | null; renewals: { order_item_id: string; period_start: string; period_end: string; applied_at: string }[] }

/** C09 — billing: plan, period, cycle, renewal history. */
export default function SiteBillingPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Billing>(`/sites/${params.id}/billing`);
    if (res.ok) setData(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.billing_title')}</h1>
      {!data.subscription ? (
        <EmptyState title={t('ui.sites.billing_none')}><p>{t('ui.sites.billing_none_body')}</p></EmptyState>
      ) : (
        <>
          <div className="card stack">
            <p style={{ margin: 0 }}>{t('ui.sites.billing_status')}: {t(`ui.sites.subscription_${data.subscription.status}`)}</p>
            <p style={{ margin: 0 }}>{t('ui.sites.billing_period')}: {dt(data.subscription.current_period_start)} → {dt(data.subscription.current_period_end)}</p>
            <p style={{ margin: 0 }}>{t('ui.sites.billing_policy', { period: String(data.subscription.policy_snapshot.period_days), grace: String(data.subscription.policy_snapshot.grace_days), retention: String(data.subscription.policy_snapshot.retention_days) })}</p>
          </div>
          <h2>{t('ui.sites.billing_renewals')}</h2>
          {data.renewals.length === 0 ? <p className="muted">{t('ui.sites.billing_no_renewals')}</p> : (
            <ul>{data.renewals.map((r) => <li key={r.order_item_id}>{dt(r.period_start)} → {dt(r.period_end)} ({t('ui.sites.billing_applied', { at: dt(r.applied_at) })})</li>)}</ul>
          )}
          <p className="muted">{t('ui.sites.billing_renew_note')}</p>
        </>
      )}
    </div>
  );
}
