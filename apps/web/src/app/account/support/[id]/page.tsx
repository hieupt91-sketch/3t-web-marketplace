'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Message { id: string; sender_type: string; body: string; created_at: string }
interface Ticket { id: string; subject: string; body: string; status: string; created_at: string; messages: Message[] }

/** Customer ticket detail: thread, reply, close. */
export default function CustomerTicketPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reply, setReply] = useState('');
  const load = useCallback(async () => {
    const res = await api<Ticket>(`/support/tickets/${params.id}`);
    if (res.ok) setTicket(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const sendReply = (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim()) return;
    void api(`/support/tickets/${params.id}/reply`, { method: 'POST', body: { body: reply } }).then((res) => {
      if (!res.ok) setError(res.error); else { setReply(''); void load(); }
    });
  };
  if (error && !ticket) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!ticket) return <Loading />;
  return (
    <div className="stack">
      <p><Link href="/account/support">← {t('ui.support.back_mine')}</Link></p>
      <h1>{ticket.subject}</h1>
      <p><StatusBadge tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'neutral'}>{t(`ui.support.status.${ticket.status}`)}</StatusBadge> <span className="muted">{dt(ticket.created_at)}</span></p>
      <div className="card stack">
        <p style={{ margin: 0 }}><strong>{t('ui.support.customer_message')}</strong></p>
        <p style={{ margin: 0 }}>{ticket.body}</p>
      </div>
      {ticket.messages.map((m) => (
        <div key={m.id} className="card stack">
          <p style={{ margin: 0 }}><strong>{m.sender_type === 'staff' ? t('ui.support.staff_message') : t('ui.support.customer_message')}</strong> <span className="muted">{dt(m.created_at)}</span></p>
          <p style={{ margin: 0 }}>{m.body}</p>
        </div>
      ))}
      {ticket.status !== 'closed' ? (
        <>
          <form className="stack" onSubmit={sendReply}>
            <label className="field"><span>{t('ui.support.reply_label_mine')}</span><textarea className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} rows={4} required /></label>
            <div className="row"><button className="button" type="submit" disabled={!reply.trim()}>{t('ui.support.reply_action')}</button></div>
          </form>
          <div className="row">
            <button type="button" className="button button--secondary" onClick={() => void api(`/support/tickets/${params.id}/close`, { method: 'POST' }).then((res) => { if (res.ok) void load(); else setError(res.error); })}>{t('ui.support.close_action')}</button>
          </div>
        </>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
