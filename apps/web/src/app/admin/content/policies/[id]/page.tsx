'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { LocaleTabs, type LocaleStatus } from '@/components/locale-tabs';
import { ContentTranslationEditor } from '@/components/content-translation-editor';
import { Alert, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Detail { id: string; code: string; version: string; status: string; effective_at: string | null; translations: { locale: Locale; title: string; body: string; review_status: LocaleStatus }[] }

function Inner() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Detail>(`/admin/content/policies/${id}`);
    if (res.ok) setDetail(res.data); else setError(res.error);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function publish() {
    setBusy(true); setActionError(null);
    const res = await api(`/admin/content/policies/${id}/publish`, { method: 'POST', body: {} });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    await load();
  }

  if (error && !detail) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!detail) return <Loading />;
  const localeStatus = (l: Locale): LocaleStatus => detail.translations.find((x) => x.locale === l)?.review_status ?? 'missing';

  return (
    <div className="stack">
      <p><Link href="/admin/content">← {t('ui.admin.content.title')}</Link></p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}><span className="mono">{detail.code}</span> · {detail.version}</h1>
        <StatusBadge tone={detail.status === 'published' ? 'success' : 'warning'}>{t(`ui.template.status.${detail.status === 'published' ? 'published' : 'draft'}`)}</StatusBadge>
      </div>
      {actionError ? <ErrorState error={actionError} /> : null}
      {actionError?.code === 'policy.default_translation_required' ? <Alert tone="warning"><p>{t('ui.admin.content.need_vi')}</p></Alert> : null}
      {detail.status === 'published' ? <Alert tone="info"><p>{t('ui.admin.content.policy_locked')}</p></Alert> : (
        <div><button type="button" className="button" disabled={busy} onClick={() => void publish()}>{t('ui.admin.content.publish_policy')}</button></div>
      )}
      <section className="card stack">
        <LocaleTabs statusFor={localeStatus} render={(locale) => (
          <ContentTranslationEditor
            key={locale}
            locale={locale}
            existing={detail.translations.find((x) => x.locale === locale)}
            onSave={async (v) => {
              const res = await api(`/admin/content/policies/${id}/translations/${locale}`, { method: 'PUT', body: { title: v.title, body: v.body, status: v.status } });
              if (res.ok) await load();
              return res.ok ? null : res.error;
            }}
          />
        )} />
      </section>
    </div>
  );
}

export default function PolicyEditor() {
  return <RequirePermission permission="policy:manage"><Inner /></RequirePermission>;
}
