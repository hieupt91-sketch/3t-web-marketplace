'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** D02 — create an isolated demo session, then hand off to the session page. */
export default function DemoStartPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { t, locale } = useT();
  const router = useRouter();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { void params.then((p) => setVersionId(p.versionId)); }, [params]);
  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    void api<{ id: string }>('/demo-sessions', { method: 'POST', body: { version_id: versionId } }).then((res) => {
      if (cancelled) return;
      if (res.ok) router.replace(`/${locale}/demo/session/${res.data.id}`);
      else setError(res.error);
    });
    return () => { cancelled = true; };
  }, [versionId, locale, router]);
  if (error) return <ErrorState error={error} onRetry={() => window.location.reload()} />;
  if (!versionId) return <Loading />;
  return (
    <div className="container stack">
      <h1>{t('ui.demo.start_title')}</h1>
      <p className="muted">{t('ui.demo.start_body')}</p>
      <Loading />
      <p><Link href={`/${locale}/templates`}>{t('ui.action.cancel')}</Link></p>
      <EmptyState title={t('ui.demo.start_note_title')}><p>{t('ui.demo.start_note_body')}</p></EmptyState>
    </div>
  );
}
