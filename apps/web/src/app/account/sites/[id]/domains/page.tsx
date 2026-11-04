'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Domain { id: string; hostname_ascii: string; status: string; is_primary: boolean; verified_at: string | null; cert_expires_at: string | null }
interface DomainChecks { ownership: boolean; routing: boolean }
interface Instructions { txt_name: string; txt_value: string }

/** Multi-part public suffixes (a small built-in set, not the full PSL):
 *  under one of these, the registrable apex has THREE labels — e.g.
 *  example.com.vn is an apex (it needs flattening/ALIAS guidance), while
 *  www.example.com.vn is a subdomain (plain CNAME). */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.vn', 'co.vn', 'com.br', 'co.kr', 'com.cn',
  'com.tw', 'co.in', 'com.mx', 'com.sg', 'com.hk', 'co.nz', 'com.ar', 'com.pl',
  'com.tr', 'co.za',
]);

function isApexHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  if (labels.length <= 2) return true;
  if (labels.length === 3) return MULTI_PART_SUFFIXES.has(labels.slice(1).join('.'));
  return false;
}

/** C08 — domains: list, primary, TLS, add wizard, verify with cooldown note.
 *  A pending domain verifies only when BOTH the TXT ownership record and
 *  the routing record are in place; the instructions card shows both, and
 *  the verify result is reported per check. The TXT value itself is only
 *  issued by the add call (the API stores a hash) — re-adding the same
 *  hostname rotates it, which is the recovery path the card explains. */
export default function SiteDomainsPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [rows, setRows] = useState<Domain[] | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [hostname, setHostname] = useState('');
  const [instructions, setInstructions] = useState<Record<string, Instructions>>({});
  const [checks, setChecks] = useState<Record<string, DomainChecks>>({});
  const [txtValue, setTxtValue] = useState('');
  const load = useCallback(async () => {
    const res = await api<{ domains: Domain[]; custom_domain_target: string }>(`/sites/${params.id}`);
    if (res.ok) { setRows(res.data.domains); setTarget(res.data.custom_domain_target); } else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  const add = (event: FormEvent) => {
    event.preventDefault();
    void api<{ id: string; txt_name?: string; txt_value?: string }>(`/sites/${params.id}/domains`, { method: 'POST', body: { hostname } }).then((res) => {
      if (!res.ok) { setError(res.error); return; }
      // A fresh add — or a re-add of the same hostname, which rotates the
      // token — returns the TXT instructions; keep them keyed by domain id
      // so the card below survives the list reload.
      if (res.data.txt_name && res.data.txt_value) {
        const issued: Instructions = { txt_name: res.data.txt_name, txt_value: res.data.txt_value };
        setInstructions((prev) => ({ ...prev, [res.data.id]: issued }));
      }
      setHostname('');
      void load();
    });
  };
  const act = (domainId: string, action: string, body?: Record<string, unknown>) => {
    void api(`/sites/${params.id}/domains/${domainId}/${action}`, { method: 'POST', body }).then((res) => {
      if (!res.ok) setError(res.error); else void load();
    });
  };
  const verify = (domainId: string) => {
    void api<{ checks?: DomainChecks }>(`/sites/${params.id}/domains/${domainId}/verify`, { method: 'POST', body: { txt_value: txtValue || undefined } }).then((res) => {
      if (!res.ok) { setError(res.error); return; }
      if (res.data.checks) {
        const result: DomainChecks = res.data.checks;
        setChecks((prev) => ({ ...prev, [domainId]: result }));
      }
      void load();
    });
  };
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  const pending = rows.filter((d) => d.status === 'pending');
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.domains_title')}</h1>
      <form className="stack" onSubmit={add}>
        <label className="field"><span>{t('ui.sites.domain_hostname')}</span><input className="input mono" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="example.com" required /></label>
        <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_hint')}</p>
        <div className="row"><button className="button" type="submit" disabled={!hostname}>{t('ui.sites.domain_add')}</button></div>
      </form>
      {pending.map((d) => {
        const issued = instructions[d.id];
        const result = checks[d.id];
        const isApex = isApexHostname(d.hostname_ascii);
        return (
          <div className="card stack" key={d.id}>
            <p style={{ margin: 0 }}><strong>{t('ui.sites.domain_dns_title')} — <span className="mono">{d.hostname_ascii}</span></strong></p>
            <p style={{ margin: 0 }}><strong>{t('ui.sites.domain_step_txt')}</strong></p>
            {issued ? (
              <p className="mono" style={{ margin: 0 }}>TXT {issued.txt_name} = {issued.txt_value}</p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_token_lost')}</p>
            )}
            <p style={{ margin: 0 }}><strong>{t('ui.sites.domain_step_routing')}</strong></p>
            <p style={{ margin: 0 }}>
              {isApex
                ? t('ui.sites.domain_routing_apex', { host: d.hostname_ascii, target })
                : t('ui.sites.domain_routing_cname', { host: d.hostname_ascii, target })}
            </p>
            <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_dns_body')}</p>
            {result ? (
              <div className="stack" style={{ gap: 4 }}>
                <p style={{ margin: 0 }}>
                  {result.ownership ? '✓' : '✗'} {t('ui.sites.domain_check_ownership')} — {result.ownership ? t('ui.sites.domain_check_pass') : t('ui.sites.domain_check_fail')}
                </p>
                {!result.ownership ? <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_fix_ownership')}</p> : null}
                <p style={{ margin: 0 }}>
                  {result.routing ? '✓' : '✗'} {t('ui.sites.domain_check_routing')} — {result.routing ? t('ui.sites.domain_check_pass') : t('ui.sites.domain_check_fail')}
                </p>
                {!result.routing ? <p className="muted" style={{ margin: 0 }}>{t('ui.sites.domain_fix_routing')}</p> : null}
              </div>
            ) : null}
          </div>
        );
      })}
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
                  {d.status === 'pending' ? <button type="button" className="button button--secondary" onClick={() => verify(d.id)}>{t('ui.sites.domain_verify')}</button> : null}
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
