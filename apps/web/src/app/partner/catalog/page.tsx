'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
interface Template { id: string; slug: string; name: string; starting_price: string | null; commission_rate_bps?: number }

export default function PartnerCatalog() {
  const { t } = useT();
  const [rows, setRows] = useState<Template[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Template[]>('/templates?limit=100');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.catalog')}</h1>
      <p>{t('ui.partner.buyer_masked')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.catalog')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.display_name')}</th><th>{t('ui.partner.links')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.slug}</td><td><a href={`/partner/links`}>{t('ui.partner.links')}</a></td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
