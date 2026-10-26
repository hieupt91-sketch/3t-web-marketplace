'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Entitlement {
  id: string;
  mode: string;
  status: string;
  instance_limit: number;
  updates_until: string | null;
  template: { id: string; slug: string };
  version: { id: string; semver: string };
  created_at: string;
}

function PurchasesInner() {
  const { t, dt, locale } = useT();
  const [ents, setEnts] = useState<Entitlement[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<Entitlement[]>('/me/entitlements');
    if (res.ok) setEnts(res.data); else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function download(ent: Entitlement) {
    setBusy(ent.id); setDownloadError(null);
    const res = await api<{ url: string }>(`/entitlements/${ent.id}/download-links`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) return setDownloadError(res.error);
    // Redeem the one-time link by navigating; the server streams the bundle as an attachment.
    window.location.href = res.data.url;
  }

  if (error && !ents) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!ents) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.account.nav.purchases')}</h1>
      {downloadError ? <ErrorState error={downloadError} /> : null}
      {ents.length === 0 ? (
        <EmptyState title={t('ui.account.purchases_empty_title')} action={<Link className="button" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>}>
          <p>{t('ui.account.purchases_empty_body')}</p>
        </EmptyState>
      ) : (
        <div className="grid-cards">
          {ents.map((e) => (
            <article key={e.id} className="card stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="mono">{e.template.slug}</strong>
                <StatusBadge tone={e.status === 'active' ? 'success' : 'neutral'}>{t(`ui.entitlement.status.${e.status}`)}</StatusBadge>
              </div>
              <dl className="details">
                <dt>{t('ui.deployment.selfhost')}</dt><dd>{t(`ui.deployment.${e.mode}`)}</dd>
                <dt>{t('ui.template_edit.version')}</dt><dd className="mono">{e.version.semver}</dd>
                <dt>{t('ui.plan.instances')}</dt><dd>{e.instance_limit}</dd>
                {e.updates_until ? <><dt>{t('ui.plan.updates')}</dt><dd className="tabular">{dt(e.updates_until)}</dd></> : null}
              </dl>
              <Link className="button button--secondary" href={`/account/purchases/${e.id}/downloads`}>{t('ui.account.downloads_title')}</Link>
              {e.mode === 'selfhost' ? (
                <button type="button" className="button" disabled={busy === e.id || e.status !== 'active'} onClick={() => void download(e)}>
                  {busy === e.id ? t('ui.state.saving') : t('ui.purchases.download')}
                </button>
              ) : (
                <p className="muted">{t('ui.purchases.hosted_pending')}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Purchases() {
  // Any signed-in user can view their purchases (the account layout already requires login).
  return <PurchasesInner />;
}
