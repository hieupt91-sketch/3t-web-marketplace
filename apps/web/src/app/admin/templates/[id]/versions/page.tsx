'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Version {
  id: string;
  semver: string;
  adapter: string;
  status: string;
  source_sha: string;
  manifest_json: { adapter?: string };
  import_id: string | null;
  artifact_kind: string;
  artifact_size: string;
  demo_url: string | null;
  is_published: boolean;
  created_at: string;
}

/** A07 — versions: SHA, manifest adapter, artifact, import, demo, published flag. */
function VersionsInner() {
  const { t, dt } = useT();
  const params = useParams<{ id: string }>();
  const [rows, setRows] = useState<Version[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Version[]>(`/admin/templates/${params.id}/versions`);
    if (res.ok) setRows(res.data); else setError(res.error);
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);
  if (error && !rows) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  return (
    <div className="stack">
      <p><Link href={`/admin/templates/${params.id}`}>← {t('ui.admin.templates_back')}</Link></p>
      <h1>{t('ui.admin.versions_title')}</h1>
      <p className="muted">{t('ui.admin.versions_note')}</p>
      {rows.length === 0 ? (
        <EmptyState title={t('ui.admin.versions_empty')}><p>{t('ui.admin.versions_empty_body')}</p></EmptyState>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>{t('ui.admin.versions_version')}</th><th>{t('ui.admin.versions_sha')}</th><th>{t('ui.admin.versions_adapter')}</th><th>{t('ui.admin.versions_artifact')}</th><th>{t('ui.admin.versions_demo')}</th><th>{t('ui.admin.versions_created')}</th></tr></thead>
          <tbody>{rows.map((v) => (
            <tr key={v.id}>
              <td>
                <span className="mono">{v.semver}</span>{' '}
                {v.is_published ? <StatusBadge tone="success">{t('ui.admin.versions_published')}</StatusBadge> : null}{' '}
                <StatusBadge tone="neutral">{v.status}</StatusBadge>
              </td>
              <td><span className="mono" title={v.source_sha}>{v.source_sha.slice(0, 12)}…</span></td>
              <td>{v.adapter}</td>
              <td>{v.artifact_kind} · {v.artifact_size}</td>
              <td>
                {v.demo_url ? <Link href={v.demo_url} target="_blank" rel="noopener">{t('ui.admin.versions_open_demo')}</Link> : '—'}{' '}
                {v.import_id ? <Link href={`/admin/imports/${v.import_id}`}>{t('ui.admin.versions_import')}</Link> : null}
              </td>
              <td className="tabular">{dt(v.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function VersionsPage() {
  return (
    <RequirePermission permission="template:read">
      <VersionsInner />
    </RequirePermission>
  );
}
