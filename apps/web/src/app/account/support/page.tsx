'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Ticket { id: string; subject: string; status: string; created_at: string }

/** Customer support: list + create. Detail + reply live on the ticket page. */
export default function CustomerSupportPage() {
  const { t, dt, locale } = useT();
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [siteLabel, setSiteLabel] = useState('');
  const load = useCallback(async () => {
    const res = await api<Ticket[]>('/support/tickets');
    if (res.ok) setRows(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void api('/support/tickets', { method: 'POST', body: { subject, body, locale, site_label: siteLabel || undefined } }).then((res) => {
      if (!res.ok) setError(res.error);
      else { setSubject(''); setBody(''); setSiteLabel(''); void load(); }
    });
  };

  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.support.my_title')}</h1>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>{t('ui.support.subject')}</span><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={200} required /></label>
        <label className="field"><span>{t('ui.support.body_label')}</span><textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={4} minLength={3} required /></label>
        <label className="field"><span>{t('ui.support.site_label')}</span><input className="input" value={siteLabel} onChange={(e) => setSiteLabel(e.target.value)} placeholder={t('ui.support.site_hint')} /></label>
        <div className="row"><button className="button" type="submit" disabled={!subject.trim() || !body.trim()}>{t('ui.support.create_action')}</button></div>
      </form>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {rows.length === 0 ? (
        <EmptyState title={t('ui.support.my_empty')}><p>{t('ui.support.my_empty_body')}</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.support.subject')}</th><th>{t('ui.support.status')}</th><th>{t('ui.support.created')}</th></tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.id}>
              <td><Link href={`/account/support/${row.id}`}>{row.subject}</Link></td>
              <td><StatusBadge tone={row.status === 'resolved' || row.status === 'closed' ? 'success' : 'neutral'}>{t(`ui.support.status.${row.status}`)}</StatusBadge></td>
              <td className="tabular">{dt(row.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
