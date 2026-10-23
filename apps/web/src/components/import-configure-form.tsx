'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { ImportDetail } from '@/app/admin/imports/[id]/page';
import { Alert, ErrorState, FormField, fieldErrorFor, useFieldError } from './ui';

interface Draft {
  projectRoot: string;
  slug: string;
  version: string;
  nameVi: string;
  nameEn: string;
  summaryVi: string;
  entry: string;
}

function initialDraft(detail: ImportDetail): Draft {
  const m = (detail.effective_manifest ?? {}) as { projectRoot?: string; slug?: string; version?: string; name?: Record<string, string>; summary?: Record<string, string>; runtime?: { entry?: string } };
  const candidate = detail.detection?.candidates[0]?.projectRoot;
  return {
    projectRoot: m.projectRoot ?? candidate ?? '.',
    slug: m.slug ?? '',
    version: m.version ?? '0.1.0',
    nameVi: m.name?.vi ?? detail.name,
    nameEn: m.name?.en ?? '',
    summaryVi: m.summary?.vi ?? '',
    entry: m.runtime?.entry ?? 'index.html',
  };
}

/**
 * A04 — allow-listed configuration only. Secrets never go here (vault, not manifest), and the
 * form never executes package config. A stale revision returns 412; the draft is kept.
 */
export function ImportConfigureForm({ detail, etag, onSaved, reload }: { detail: ImportDetail; etag: string; onSaved: () => void; reload: () => Promise<unknown> }) {
  const { t } = useT();
  const fieldError = useFieldError();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(detail));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = (key: keyof Draft) => (event: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [key]: event.target.value }));
    setDirty(true);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const name: Record<string, string> = { vi: draft.nameVi.trim() };
    if (draft.nameEn.trim()) name.en = draft.nameEn.trim();
    const res = await api('/admin/imports/' + detail.id + '/configuration', {
      method: 'PATCH',
      ifMatch: etag,
      body: {
        projectRoot: draft.projectRoot.trim() || '.',
        slug: draft.slug.trim(),
        version: draft.version.trim(),
        name,
        summary: { vi: draft.summaryVi.trim() || draft.nameVi.trim() },
        entry: draft.entry.trim() || 'index.html',
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDirty(false);
    onSaved();
  }

  const candidates = detail.detection?.candidates ?? [];
  return (
    <form className="card stack" onSubmit={submit}>
      <h2 style={{ margin: 0 }}>{t('ui.import.configure.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('ui.import.configure.lead')}</p>
      {error?.code === 'resource.revision_conflict' ? (
        <Alert tone="warning" title={t('error.resource.revision_conflict')}>
          <p>
            <button type="button" className="button button--secondary" onClick={() => void reload().then(() => setError(null))}>
              {t('ui.import.configure.load_latest')}
            </button>
          </p>
        </Alert>
      ) : error ? (
        <ErrorState error={error} />
      ) : null}
      <FormField label={t('ui.import.configure.project_root')} hint={t('ui.import.configure.project_root_hint')} error={fieldError(fieldErrorFor(error, 'projectRoot'))}>
        {(p) =>
          candidates.length > 1 ? (
            <select {...p} className="select" value={draft.projectRoot} onChange={set('projectRoot')}>
              {candidates.map((c) => (
                <option key={c.projectRoot} value={c.projectRoot}>
                  {c.projectRoot}
                </option>
              ))}
            </select>
          ) : (
            <input {...p} className="input mono" value={draft.projectRoot} onChange={set('projectRoot')} />
          )
        }
      </FormField>
      <FormField label={t('ui.import.configure.entry')}>
        {(p) => <input {...p} className="input mono" value={draft.entry} onChange={set('entry')} />}
      </FormField>
      <FormField label={t('ui.import.configure.slug')} hint={t('ui.import.configure.slug_hint')}>
        {(p) => <input {...p} className="input mono" value={draft.slug} onChange={set('slug')} required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" />}
      </FormField>
      <FormField label={t('ui.import.configure.version')} hint={t('ui.import.configure.version_hint')}>
        {(p) => <input {...p} className="input mono" value={draft.version} onChange={set('version')} required />}
      </FormField>
      <FormField label={t('ui.import.configure.name_vi')}>
        {(p) => <input {...p} className="input" lang="vi" value={draft.nameVi} onChange={set('nameVi')} required maxLength={200} />}
      </FormField>
      <FormField label={t('ui.import.configure.name_en')} hint={t('ui.import.configure.name_en_hint')}>
        {(p) => <input {...p} className="input" lang="en" value={draft.nameEn} onChange={set('nameEn')} maxLength={200} />}
      </FormField>
      <FormField label={t('ui.import.configure.summary_vi')}>
        {(p) => <textarea {...p} className="textarea" lang="vi" value={draft.summaryVi} onChange={set('summaryVi')} maxLength={500} rows={3} />}
      </FormField>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>{busy ? t('ui.state.saving') : t('ui.import.configure.submit')}</button>
        {dirty ? <span className="muted">{t('ui.state.unsaved')}</span> : null}
      </div>
    </form>
  );
}
