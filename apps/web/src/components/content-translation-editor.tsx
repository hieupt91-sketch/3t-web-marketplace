'use client';

import { useState } from 'react';
import type { Locale } from '@3t/i18n';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Alert, ErrorState, FormField } from './ui';

export interface TranslationValue {
  title: string;
  body: string;
  seo_title?: string;
  seo_description?: string;
  status: 'draft' | 'reviewed' | 'published';
}

/** Translations arrive from the API with status possibly 'stale' and SEO fields possibly null. */
export interface ExistingTranslation {
  title?: string;
  body?: string;
  seo_title?: string | null;
  seo_description?: string | null;
  status?: 'draft' | 'reviewed' | 'published' | 'stale' | 'missing';
}

/** Shared translation form for a CMS page or policy (body is restricted markdown). */
export function ContentTranslationEditor({ locale, existing, onSave, withSeo }: { locale: Locale; existing: ExistingTranslation | undefined; onSave: (v: TranslationValue) => Promise<ApiError | null>; withSeo?: boolean }) {
  const { t } = useT();
  const [form, setForm] = useState<TranslationValue>({
    title: existing?.title ?? '',
    body: existing?.body ?? '',
    seo_title: existing?.seo_title ?? '',
    seo_description: existing?.seo_description ?? '',
    status: existing?.status === 'draft' || existing?.status === 'reviewed' || existing?.status === 'published' ? existing.status : 'draft',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof TranslationValue) => (e: { target: { value: string } }) => { setForm((f) => ({ ...f, [k]: e.target.value })); setSaved(false); };

  async function save() {
    setBusy(true);
    setError(null);
    const err = await onSave(form);
    setBusy(false);
    if (err) return setError(err);
    setSaved(true);
  }

  return (
    <div className="stack">
      {error ? <ErrorState error={error} /> : null}
      {saved ? <Alert tone="success" live><p>{t('ui.template_edit.saved')}</p></Alert> : null}
      <FormField label={t('ui.template_edit.title')}>{(p) => <input {...p} className="input" lang={locale} value={form.title} onChange={set('title')} maxLength={200} />}</FormField>
      <FormField label={t('ui.content.body')} hint={t('ui.content.body_hint')}>{(p) => <textarea {...p} className="textarea" lang={locale} rows={12} value={form.body} onChange={set('body')} maxLength={50000} />}</FormField>
      {withSeo ? (
        <>
          <FormField label={t('ui.template_edit.seo_title')}>{(p) => <input {...p} className="input" lang={locale} value={form.seo_title} onChange={set('seo_title')} maxLength={200} />}</FormField>
          <FormField label={t('ui.template_edit.seo_description')}>{(p) => <textarea {...p} className="textarea" lang={locale} rows={2} value={form.seo_description} onChange={set('seo_description')} maxLength={400} />}</FormField>
        </>
      ) : null}
      <FormField label={t('ui.template_edit.translation_status')}>{(p) => (
        <select {...p} className="select" value={form.status} onChange={set('status')}>
          <option value="draft">{t('ui.locale_status.draft')}</option>
          <option value="reviewed">{t('ui.locale_status.reviewed')}</option>
          <option value="published">{t('ui.locale_status.published')}</option>
        </select>
      )}</FormField>
      <div><button type="button" className="button" disabled={busy || !form.title} onClick={() => void save()}>{busy ? t('ui.state.saving') : t('ui.template_edit.save_translation')}</button></div>
    </div>
  );
}
