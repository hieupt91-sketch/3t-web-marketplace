'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Domain { id: string; hostname_ascii: string; status: string; is_primary: boolean; verified_at: string | null; cert_expires_at: string | null }

/** C08 — domains: list, primary, TLS, add wizard, verify with cooldown note. */
export default function SiteDomainsPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [rows, setRows] = useState<Domain[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [hostname, setHostname] = useState('');
  const [added, setAdded] = useState<{ txt_name: string; txt_value: string } | null>(null);
  const [txtValue, setTxtValue] = useState('');
  const load = useCallback(async () => {
    const res = await api<{ domains: Domain[] }>(`/sites/${params.id}`);
    if (res.ok) setRows(res.data.domains); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const add = (event: FormEvent) => {
    event.preventDefault();
    void api<{ txt_name: string; txt_value: string }>(`/sites/${params.id}/domains`, { method: 'POST', body: { hostname } }).then((res) => {
      if (!res.ok) setError(res.error); else { setAdded(res.data); setHostname(''); void load(); }
    });
  };
  const act = (domainId: string, action: string, body?: Record<string, unknown>) => {
    void api(`/sites/${params.id}/domains/${domainId}/${action}`, { method: 'POST', body }).then((res) => {
      if (!res.ok) setError(res.error); else void load();
    });
  };
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.domains_title')}</h1>
      <form className="stack" onSubmit={add}>
        <label className="field"><span>{t('ui.sites.domain_hostname')}</span><input className="input mono" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="example.com" required /></label>
        <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_hint')}</p>
        <div className="row"><button className="button" type="submit" disabled={!hostname}>{t('ui.sites.domain_add')}</button></div>
      </form>
      {added ? (
        <div className="card stack">
          <p style={{ margin: 0 }}><strong>{t('ui.sites.domain_dns_title')}</strong></p>
          <p className="mono" style={{ margin: 0 }}>TXT {added.txt_name} = {added.txt_value}</p>
          <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_dns_body')}</p>
        </div>
      ) : null}
      {rows.length === 0 ? <EmptyState title={t('ui.sites.domains_empty')}><p>{t('ui.sites.domains_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.domain_hostname')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.sites.domain_tls')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.hostname_ascii}{d.is_primary ? ` (${t('ui.sites.domain_primary')})` : ''}</td>
              <td><StatusBadge tone={d.status === 'verified' ? 'success' : 'neutral'}>{t(`ui.sites.domain_${d.status}`)}</StatusBadge></td>
              <td className="tabular">{d.cert_expires_at ? dt(d.cert_expires_at) : '—'}</td>
              <td>
                <div className="row">
                  {d.status === 'pending' ? <button type="button" className="button button--secondary" onClick={() => act(d.id, 'verify', { txt_value: txtValue || undefined })}>{t('ui.sites.domain_verify')}</button> : null}
                  {d.status === 'verified' && !d.is_primary ? <button type="button" className="button button--secondary" onClick={() => act(d.id, 'make-primary')}>{t('ui.sites.domain_make_primary')}</button> : null}
                  {d.status !== 'released' ? <button type="button" className="button button--danger" onClick={() => act(d.id, 'release')}>{t('ui.sites.domain_release')}</button> : null}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <label className="field" style={{ maxWidth: 500 }}><span>{t('ui.sites.domain_txt_value')}</span><input className="input mono" value={txtValue} onChange={(e) => setTxtValue(e.target.value)} placeholder={t('ui.sites.domain_txt_hint')} /></label>
      <p className="muted">{t('ui.sites.domain_cooldown_note')}</p>
    </div>
  );
}
