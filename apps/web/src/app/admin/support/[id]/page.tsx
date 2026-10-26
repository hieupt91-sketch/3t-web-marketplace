'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Message { id: string; sender_type: string; body: string; locale: string; created_at: string }
interface Ticket {
  id: string; subject: string; body: string; status: string; locale: string;
  assigned_to: string | null; order_id: string | null; site_label: string | null;
  sla_breached: boolean; created_at: string; messages: Message[];
}

/** A26 — ticket detail: thread, assign, reply in the customer's locale, resolve/close. */
function TicketInner() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reply, setReply] = useState('');
  const [assignee, setAssignee] = useState('');
  const load = useCallback(async () => {
    const res = await api<Ticket>(`/admin/support/${params.id}`);
    if (res.ok) setTicket(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (path: string, body: Record<string, unknown>) => {
    const res = await api(`/admin/support/${params.id}/${path}`, { method: 'POST', body });
    if (!res.ok) setError(res.error); else await load();
  }, [params.id, load]);

  const sendReply = (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim()) return;
    void act('reply', { body: reply }).then(() => setReply(''));
  };

  if (error && !ticket) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!ticket) return <Loading />;
  return (
    <div className="stack">
      <p><Link href="/admin/support">← {t('ui.support.back_queue')}</Link></p>
      <h1>{ticket.subject}</h1>
      <p>
        <StatusBadge tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'neutral'}>{t(`ui.support.status.${ticket.status}`)}</StatusBadge>{' '}
        {ticket.sla_breached ? <StatusBadge tone="error">{t('ui.support.sla_breached')}</StatusBadge> : null}{' '}
        <span className="muted">{t('ui.support.locale', { locale: ticket.locale })} · {dt(ticket.created_at)}</span>
      </p>
      {ticket.order_id ? <p className="muted">{t('ui.support.linked_order')}: <Link className="mono" href={`/admin/payments/reconciliation`}>{ticket.order_id.slice(0, 8)}…</Link></p> : null}
      {ticket.site_label ? <p className="muted">{t('ui.support.linked_site')}: {ticket.site_label}</p> : null}
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
            <label className="field">
              <span>{t('ui.support.reply_label', { locale: ticket.locale })}</span>
              <textarea className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} rows={4} required />
            </label>
            <div className="row"><button className="button" type="submit" disabled={!reply.trim()}>{t('ui.support.reply_action')}</button></div>
          </form>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (assignee) void act('assign', { staff_id: assignee }); }}>
            <label className="field" style={{ maxWidth: 400 }}>
              <span>{t('ui.support.assign_label')}</span>
              <input className="input mono" value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder={t('ui.support.assign_hint')} />
            </label>
            <div className="row"><button className="button button--secondary" type="submit" disabled={!assignee}>{t('ui.support.assign_action')}</button></div>
          </form>
          <div className="row">
            <button className="button button--secondary" onClick={() => void act('status', { status: 'resolved' })}>{t('ui.support.resolve_action')}</button>
            <button className="button button--danger" onClick={() => void act('status', { status: 'closed' })}>{t('ui.support.close_action')}</button>
          </div>
        </>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}

export default function TicketPage() {
  return (
    <RequirePermission permission="support:read">
      <TicketInner />
    </RequirePermission>
  );
}
