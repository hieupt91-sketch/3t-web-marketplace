'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface SiteContent {
  id: string;
  display_name: string;
  status: string;
  url: string | null;
  capabilities: string[];
}

/**
 * ACC per-site "Nội dung" tab (docs/12 §8). Capability-aware on purpose:
 * a dynamic site's content is edited in the site's OWN admin panel (the
 * platform never impersonates the site admin), while a static template
 * has no admin at all — the honest guidance is files or the editing
 * service, never a fake in-platform editor.
 */
export default function SiteContentPage() {
  const { t } = useT();
  const params = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteContent | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<SiteContent>(`/sites/${params.id}`);
    if (res.ok) setSite(res.data);
    else setError(res.error);
  }, [params.id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState error={error} />;
  if (!site) return <Loading />;

  const dynamic = site.capabilities.includes('admin');
  return (
    <div className="stack">
      <h1>{t('ui.sites.tab_content')} — {site.display_name}</h1>
      {dynamic ? (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('ui.sites.content_dynamic_title')}</h2>
          <p style={{ margin: 0 }}>{t('ui.sites.content_dynamic_body')}</p>
          {site.url ? (
            <p style={{ margin: 0 }}>
              <a className="button" href={`${site.url}admin/`} target="_blank" rel="noreferrer">{t('ui.sites.content_open_admin')}</a>
            </p>
          ) : null}
          <p className="muted" style={{ margin: 0 }}>{t('ui.sites.content_dynamic_backup_note')}</p>
          <p style={{ margin: 0 }}><Link href={`/account/sites/${site.id}/backups`}>{t('ui.sites.tab_backups')}</Link></p>
        </div>
      ) : (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('ui.sites.content_static_title')}</h2>
          <p style={{ margin: 0 }}>{t('ui.sites.content_static_body')}</p>
          <div className="row">
            <Link className="button button--secondary" href="/account/purchases">{t('ui.sites.content_static_downloads')}</Link>
            <Link className="button button--secondary" href="/account/support/new">{t('ui.sites.content_static_support')}</Link>
          </div>
        </div>
      )}
      <p><Link href={`/account/sites/${site.id}`}>{site.display_name}</Link></p>
    </div>
  );
}
