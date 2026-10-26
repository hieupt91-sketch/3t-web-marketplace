'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
interface Delivery { id: string; event_id: string; event_type: string; status: string; attempts: number; response_status: number | null; created_at: string }

export default function PartnerDeliveries({ params }: { params: { id: string } }) {
  const { t } = useT();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Delivery[]>(`/partner/webhooks/${params.id}/deliveries`);
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.webhooks')}</h1>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.webhooks')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.webhooks')}</th><th>{t('ui.partner.status')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td className="mono">{r.event_type}</td><td>{r.status} · {r.attempts}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
