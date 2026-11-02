'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DemoViewer } from '@/components/demo-viewer';
import { EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Session {
  id: string;
  version_id: string;
  template_slug: string | null;
  url: string | null;
  admin_url: string | null;
  admin_launched: boolean;
  status: string;
  expires_at: string;
  created_at: string;
}

function countdown(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** D03 — isolated demo session: URL, admin entry, countdown, reset, buy/keep. D04 is the expired state below. */
export default function DemoSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { t, locale, dt } = useT();
  const [id, setId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { void params.then((p) => setId(p.id)); }, [params]);
  const load = useCallback(async () => {
    if (!id) return;
    const res = await api<Session>(`/demo-sessions/${id}`);
    if (res.ok) setSession(res.data); else setError(res.error);
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (session?.status !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.status]);

  const act = useCallback(async (action: 'admin-launch' | 'reset' | 'cancel') => {
    if (!id) return;
    setBusy(action);
    const res = await api<{ admin_url?: string }>(`/demo-sessions/${id}/${action}`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) setError(res.error);
    else if (action === 'admin-launch' && res.data.admin_url) window.open(res.data.admin_url, '_blank', 'noopener');
    await load();
  }, [id, load]);

  if (error && !session) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!session) return <Loading />;

  if (session.status !== 'active') {
    // D04 — expired/cancelled: never pretend deleted demo data is kept.
    return (
      <div className="container stack">
        <h1>{t('ui.demo.expired_title')}</h1>
        <EmptyState title={t('ui.demo.expired_heading')}>
          <p>{t('ui.demo.expired_body')}</p>
        </EmptyState>
        <div className="row">
          <Link className="button" href={`/${locale}/demo/start/${session.version_id}`}>{t('ui.demo.recreate')}</Link>
          {session.template_slug ? <Link className="button button--secondary" href={`/${locale}/templates/${session.template_slug}`}>{t('ui.demo.buy_template')}</Link> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="container stack">
      <h1>{t('ui.demo.session_title')}</h1>
      <p>
        <StatusBadge tone="success">{t(`ui.demo.status.${session.status}`)}</StatusBadge>{' '}
        <span className="muted">{t('ui.demo.expires_in', { countdown: countdown(session.expires_at, now) })}</span>{' '}
        <span className="muted">{t('ui.demo.expires_at', { at: dt(session.expires_at) })}</span>
      </p>
      {session.url ? (
        <DemoViewer url={session.url} title={t('ui.demo.session_title')} />
      ) : (
        <EmptyState title={t('ui.demo.unavailable')}><p>{t('ui.demo.unavailable_body')}</p></EmptyState>
      )}
      <div className="row">
        <button type="button" className="button" disabled={busy !== null} onClick={() => void act('admin-launch')}>{t('ui.demo.admin_launch')}</button>
        <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => void act('reset')}>{t('ui.demo.reset')}</button>
        <button type="button" className="button button--danger" disabled={busy !== null} onClick={() => void act('cancel')}>{t('ui.demo.cancel')}</button>
        {session.template_slug ? <Link className="button button--secondary" href={`/${locale}/templates/${session.template_slug}`}>{t('ui.demo.buy_template')}</Link> : null}
      </div>
      {session.admin_launched && session.admin_url ? (
        <p><Link href={session.admin_url} target="_blank" rel="noopener">{t('ui.demo.admin_open')}</Link></p>
      ) : null}
      <p className="muted">{t('ui.demo.session_note')}</p>
    </div>
  );
}
