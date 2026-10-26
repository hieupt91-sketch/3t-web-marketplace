'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
interface Cell { status: string; updated_at: string | null }
interface Row { template_id: string; slug: string; locales: Record<string, Cell> }

function TranslationsInner() {
  const { t } = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Row[]>('/admin/translations');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.translations')}</h1>
      <p>{t('ui.admin.translations_help')}</p>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.translations')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.display_name')}</th><th>vi</th><th>en</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.template_id}><td>{r.slug}</td><td>{r.locales.vi?.status}</td><td>{r.locales.en?.status}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

export default function AdminTranslations() {
  return <RequirePermission permission="template:read"><TranslationsInner /></RequirePermission>;
}
