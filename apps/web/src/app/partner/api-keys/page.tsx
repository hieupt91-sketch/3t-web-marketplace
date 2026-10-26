'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
const SCOPES = ['catalog:read', 'demo:link', 'checkout:create', 'orders:read', 'commissions:read', 'events:read'];
interface KeyRow { id: string; prefix: string; scopes: string[]; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; created_at: string }

export default function PartnerKeys() {
  const { t } = useT();
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [scopes, setScopes] = useState<string[]>(['catalog:read']);
  const [secret, setSecret] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<KeyRow[]>('/partner/api-keys');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await api<{ secret: string }>('/partner/api-keys', { method: 'POST', body: { scopes } });
    if (!res.ok) return setError(res.error);
    setSecret(res.data.secret); void load();
  }
  async function revoke(id: string) {
    const res = await api(`/partner/api-keys/${id}/revoke`, { method: 'POST', body: {} });
    if (!res.ok) return setError(res.error);
    void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.api_keys')}</h1>
      {error ? <ErrorState error={error} /> : null}
      {secret ? <p role="status">{t('ui.partner.secret_once')} <span className="mono">{secret}</span></p> : null}
      <form onSubmit={create} className="stack">
        {SCOPES.map((s) => (<label key={s}><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s}</label>))}
        <button className="button">{t('ui.partner.api_keys')}</button>
      </form>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.api_keys')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.api_keys')}</th><th>{t('ui.partner.status')}</th><th>{t('ui.table.actions')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td className="mono">{r.prefix}…</td><td>{r.revoked_at ? 'revoked' : 'active'}</td><td>{r.revoked_at ? null : <button className="button button--danger" onClick={() => void revoke(r.id)}>revoke</button>}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
