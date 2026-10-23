'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { templateTone } from '@/lib/status';

interface AdminTemplate {
  id: string;
  slug: string;
  status: string;
  titles: Record<string, string>;
  latest_version: { id: string; semver: string; adapter: string; status: string; locales: string[] | null; import_id: string | null } | null;
  version_count: number;
  updated_at: string;
}

/** A02 — template list with real versions; pricing and editing screens arrive in M3. */
function TemplatesInner() {
  const { t, dt, locale } = useT();
  const me = useCurrentUser();
  const [rows, setRows] = useState<AdminTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (after: string | null) => {
    const res = await api<AdminTemplate[]>(`/admin/templates?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`);
    if (!res.ok) return setError(res.error);
    const page = (res.raw as { page: { next_cursor: string | null } }).page;
    setRows((prev) => (after ? [...prev, ...res.data] : res.data));
    setCursor(page.next_cursor);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('ui.admin.templates.title')}</h1>
        {me.permissions.includes('template:import') ? <Link className="button" href="/admin/imports/new">{t('ui.admin.nav.import_new')}</Link> : null}
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load(null)} /> : null}
      {!loaded && !error ? <Loading /> : null}
      {loaded && rows.length === 0 ? (
        <EmptyState title={t('ui.admin.templates.empty_title')}>
          <p>{t('ui.admin.templates.empty_body')}</p>
        </EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.admin.templates.col_name')}</th>
                <th scope="col">{t('ui.admin.templates.col_status')}</th>
                <th scope="col">{t('ui.admin.templates.col_version')}</th>
                <th scope="col">{t('ui.admin.templates.col_locales')}</th>
                <th scope="col">{t('ui.admin.templates.col_price')}</th>
                <th scope="col">{t('ui.admin.templates.col_updated')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/admin/templates/${row.id}`}><strong>{row.titles[locale] ?? row.titles.vi ?? row.slug}</strong></Link>
                    <div className="mono muted">{row.slug}</div>
                  </td>
                  <td><StatusBadge tone={templateTone(row.status)}>{t(`ui.template.status.${row.status}`)}</StatusBadge></td>
                  <td>
                    {row.latest_version ? (
                      <>
                        <span className="mono">{row.latest_version.semver}</span> · {row.latest_version.adapter}
                        <div className="muted">{t('ui.admin.templates.version_count', { count: row.version_count })}</div>
                        {row.latest_version.import_id ? <Link href={`/admin/imports/${row.latest_version.import_id}`}>{t('ui.admin.templates.open_import')}</Link> : null}
                      </>
                    ) : '—'}
                  </td>
                  <td>{(row.latest_version?.locales ?? []).join(', ').toUpperCase() || '—'}</td>
                  <td className="muted">{t('ui.admin.templates.price_unset')}</td>
                  <td className="tabular">{dt(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {cursor ? <div><button type="button" className="button button--secondary" onClick={() => void load(cursor)}>{t('ui.catalog.more')}</button></div> : null}
    </div>
  );
}

export default function AdminTemplates() {
  return (
    <RequirePermission permission="template:read">
      <TemplatesInner />
    </RequirePermission>
  );
}
