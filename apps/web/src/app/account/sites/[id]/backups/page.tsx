'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Backup { id: string; kind: string; status: string; checksum: string | null; created_at: string; expires_at: string | null }

/** Dynamic-site content backups (docs/12): snapshots of the site's own
 *  content.json — the same file the site's admin panel backs up. Shown
 *  only for dynamic sites; restores reuse the page's name confirmation. */
function ContentBackups({ siteId, siteName, confirmName }: { siteId: string; siteName: string; confirmName: string }) {
  const { t, dt } = useT();
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [invalidFile, setInvalidFile] = useState(false);
  const load = useCallback(async () => {
    const res = await api<Backup[]>(`/sites/${siteId}/content-backups`);
    if (res.ok) setRows(res.data);
    else setError(res.error);
  }, [siteId]);
  useEffect(() => { void load(); }, [load]);

  async function uploadRestore(file: File) {
    setInvalidFile(false);
    setError(null);
    let content: unknown;
    try {
      content = JSON.parse(await file.text()) as unknown;
    } catch {
      setInvalidFile(true);
      return;
    }
    const res = await api(`/sites/${siteId}/content-backups/restore-upload`, { method: 'POST', body: { content, confirm_name: confirmName } });
    if (!res.ok) {
      if (res.error.field_errors.some((f) => f.field === 'content')) setInvalidFile(true);
      else setError(res.error);
      return;
    }
    void load();
  }

  return (
    <section className="stack card">
      <h2 style={{ margin: 0 }}>{t('ui.sites.content_backup_title')}</h2>
      <p style={{ margin: 0 }}>{t('ui.sites.content_backup_intro')}</p>
      <div className="row">
        <button type="button" className="button" onClick={() => void api(`/sites/${siteId}/content-backups`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.content_backup_create')}</button>
      </div>
      {rows === null ? <Loading /> : rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('ui.sites.content_backup_empty')}</p> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.backup_created')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td className="tabular">{dt(b.created_at)}</td>
              <td><StatusBadge tone={b.status === 'succeeded' ? 'success' : 'neutral'}>{t(`ui.sites.backup_${b.status}`)}</StatusBadge></td>
              <td>
                <div className="row">
                  {b.status === 'succeeded' ? <a className="button button--secondary" href={`/api/v1/sites/${siteId}/content-backups/${b.id}/download`}>{t('ui.sites.content_backup_download')}</a> : null}
                  {b.status === 'succeeded' ? <button type="button" className="button button--secondary" disabled={confirmName !== siteName} onClick={() => void api(`/sites/${siteId}/content-backups/${b.id}/restore`, { method: 'POST', body: { confirm_name: confirmName } }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.backup_restore')}</button> : null}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <label className="field">
        <span>{t('ui.sites.content_backup_upload_label')}</span>
        <input
          className="input"
          type="file"
          accept=".json,application/json"
          disabled={confirmName !== siteName}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadRestore(file);
            e.target.value = '';
          }}
        />
      </label>
      {invalidFile ? <p role="alert">{t('ui.sites.content_backup_invalid')}</p> : null}
      <p className="muted" style={{ margin: 0 }}>{t('ui.sites.content_backup_note')}</p>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </section>
  );
}

/** C10 — backups: milestones, create, restore with name confirmation, maintenance note. */
export default function SiteBackupsPage() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [siteName, setSiteName] = useState('');
  const [dynamic, setDynamic] = useState(false);
  const load = useCallback(async () => {
    const [backups, site] = await Promise.all([
      api<Backup[]>(`/sites/${params.id}/backups`),
      api<{ display_name: string; capabilities?: string[] }>(`/sites/${params.id}`),
    ]);
    if (backups.ok) setRows(backups.data); else setError(backups.error);
    if (site.ok) {
      setSiteName(site.data.display_name);
      setDynamic((site.data.capabilities ?? []).includes('admin'));
    }
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/account/sites/${params.id}`}>← {t('ui.sites.back_site')}</Link></p>
      <h1>{t('ui.sites.backups_title')}</h1>
      <div className="row">
        <button type="button" className="button" onClick={() => void api(`/sites/${params.id}/backups`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.backup_create')}</button>
        <button type="button" className="button button--secondary" onClick={() => void api(`/sites/${params.id}/exports`, { method: 'POST' }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.export_create')}</button>
      </div>
      {rows.length === 0 ? <EmptyState title={t('ui.sites.backups_empty')}><p>{t('ui.sites.backups_empty_body')}</p></EmptyState> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.sites.backup_kind')}</th><th>{t('ui.sites.status')}</th><th>{t('ui.sites.backup_checksum')}</th><th>{t('ui.sites.backup_created')}</th><th>{t('ui.table.actions')}</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id}>
              <td>{t(`ui.sites.backup_${b.kind}`)}</td>
              <td><StatusBadge tone={b.status === 'succeeded' ? 'success' : 'neutral'}>{t(`ui.sites.backup_${b.status}`)}</StatusBadge></td>
              <td className="mono">{b.checksum ? `${b.checksum.slice(0, 12)}…` : '—'}</td>
              <td className="tabular">{dt(b.created_at)}</td>
              <td>
                <div className="row">
                  {b.status === 'succeeded' && b.kind === 'export' ? <a className="button button--secondary" href={`/api/v1/sites/${params.id}/exports/${b.id}/download`}>{t('ui.sites.export_download')}</a> : null}
                  {b.status === 'succeeded' ? <button type="button" className="button button--secondary" disabled={confirmName !== siteName} onClick={() => void api(`/sites/${params.id}/backups/${b.id}/restore`, { method: 'POST', body: { confirm_name: confirmName } }).then((res) => { if (!res.ok) setError(res.error); else void load(); })}>{t('ui.sites.backup_restore')}</button> : null}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {dynamic ? <ContentBackups siteId={params.id} siteName={siteName} confirmName={confirmName} /> : null}
      <label className="field" style={{ maxWidth: 400 }}>
        <span>{t('ui.sites.restore_confirm', { name: siteName })}</span>
        <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={siteName} />
      </label>
      <p className="muted">{t('ui.sites.restore_note')}</p>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
