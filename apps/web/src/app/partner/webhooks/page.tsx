'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
const EVENTS = ['order.created', 'order.paid', 'order.cancelled', 'fulfillment.ready', 'fulfillment.failed', 'refund.settled', 'commission.eligible', 'commission.reversed', 'payout.paid', 'payout.failed'];
interface Endpoint { id: string; url: string; events: string[]; status: string; created_at: string }

export default function PartnerWebhooks() {
  const { t } = useT();
  const [rows, setRows] = useState<Endpoint[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['order.paid']);
  const [secret, setSecret] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await api<Endpoint[]>('/partner/webhooks');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await api<{ secret: string }>('/partner/webhooks', { method: 'POST', body: { url, events } });
    if (!res.ok) return setError(res.error);
    setSecret(res.data.secret); void load();
  }
  async function test(id: string) {
    setBusy(id);
    const res = await api(`/partner/webhooks/${id}/test`, { method: 'POST', body: {} });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.partner.webhooks')}</h1>
      <p>{t('ui.partner.webhook_test_note')}</p>
      {error ? <ErrorState error={error} /> : null}
      {secret ? <p role="status">{t('ui.partner.secret_once')} <span className="mono">{secret}</span></p> : null}
      <form onSubmit={create} className="stack">
        <label>{t('ui.partner.webhooks')}<input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://…" /></label>
        {EVENTS.map((ev) => (<label key={ev}><input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} /> {ev}</label>))}
        <button className="button">{t('ui.partner.webhooks')}</button>
      </form>
      {rows.length === 0 ? <EmptyState title={t('ui.partner.webhooks')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.partner.webhooks')}</th><th>{t('ui.partner.status')}</th><th>{t('ui.table.actions')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td className="mono">{r.url}</td><td>{r.status}</td><td><button className="button button--secondary" disabled={busy === r.id} onClick={() => void test(r.id)}>test</button> <Link className="button button--secondary" href={`/partner/webhooks/${r.id}/deliveries`}>deliveries</Link></td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}
