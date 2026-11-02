'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '@3t/i18n';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { LocaleTabs, type LocaleStatus } from '@/components/locale-tabs';
import { ContentTranslationEditor } from '@/components/content-translation-editor';
import { Alert, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { templateTone } from '@/lib/status';

interface Detail { id: string; slug: string; kind: string; status: string; row_version: number; translations: { locale: Locale; title: string; body: string; seo_title: string | null; seo_description: string | null; status: LocaleStatus }[] }

function Inner() {
  const { t } = useT();
  const me = useCurrentUser();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const canPublish = me.permissions.includes('content:publish');

  const load = useCallback(async () => {
    const res = await api<Detail>(`/admin/content/pages/${id}`);
    if (res.ok) { setDetail(res.data); setEtag(res.etag); } else setError(res.error);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function publish() {
    setBusy(true); setActionError(null);
    const res = await api(`/admin/content/pages/${id}/publish`, { method: 'POST', ifMatch: etag });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    await load();
  }

  if (error && !detail) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!detail) return <Loading />;
  const localeStatus = (l: Locale): LocaleStatus => detail.translations.find((x) => x.locale === l)?.status ?? 'missing';

  return (
    <div className="stack">
      <p><Link href="/admin/content">← {t('ui.admin.content.title')}</Link></p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }} className="mono">{detail.slug}</h1>
        <StatusBadge tone={templateTone(detail.status)}>{t(`ui.template.status.${detail.status}`)}</StatusBadge>
      </div>
      {actionError ? <ErrorState error={actionError} /> : null}
      {actionError?.code === 'content.default_translation_required' ? <Alert tone="warning"><p>{t('ui.admin.content.need_vi')}</p></Alert> : null}
      {canPublish && detail.status !== 'published' ? <div><button type="button" className="button" disabled={busy} onClick={() => void publish()}>{t('ui.template_edit.publish_action')}</button></div> : null}
      <section className="card stack">
        <LocaleTabs statusFor={localeStatus} render={(locale) => (
          <ContentTranslationEditor
            key={locale}
            locale={locale}
            withSeo
            existing={detail.translations.find((x) => x.locale === locale)}
            onSave={async (v) => {
              const res = await api(`/admin/content/pages/${id}/translations/${locale}`, { method: 'PUT', body: v });
              if (res.ok) await load();
              return res.ok ? null : res.error;
            }}
          />
        )} />
      </section>
    </div>
  );
}

export default function ContentPageEditor() {
  return <RequirePermission permission="content:write"><Inner /></RequirePermission>;
}
