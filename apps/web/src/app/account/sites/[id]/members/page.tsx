'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Member { user_id: string; role: string; email: string }

/** C12 — members: invite existing users, revoke. Never removes the last owner. */
export default function SiteMembersPage() {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const [rows, setRows] = useState<Member[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [email, setEmail] = useState('');
  const load = useCallback(async () => {
    const res = await api<Member[]>(`/sites/${params.id}/members`);
    if (res.ok) setRows(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const invite = (event: FormEvent) => {
    event.preventDefault();
    void api(`/sites/${params.id}/members`, { method: 'POST', body: { email } }).then((res) => {
      if (!res.ok) setError(res.error); else { setEmail(''); void load(); }
    });
  };
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.members_title')}</h1>
      <p className="muted">{t('ui.sites.members_note')}</p>
      <form className="stack" onSubmit={invite}>
        <label className="field"><span>{t('ui.sites.member_email')}</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <div className="row"><button className="button" type="submit" disabled={!email}>{t('ui.sites.member_invite')}</button></div>
      </form>
      {rows.length === 0 ? <EmptyState title={t('ui.sites.members_empty')}><p>{t('ui.sites.members_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.member_email')}</th><th>{t('ui.sites.member_role')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={m.user_id}>
              <td>{m.email}</td>
              <td>{t(`ui.sites.member_${m.role}`)}</td>
              <td>{m.role !== 'owner' ? <button className="button button--danger" onClick={() => void api(`/sites/${params.id}/members/${m.user_id}`, { method: 'DELETE' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.member_revoke')}</button> : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
