'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState } from '@/components/ui';
import { ImportStepper } from '@/components/import-stepper';
import { api, uploadWithProgress, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

const MAX_BYTES = 100 * 1024 * 1024; // mirrors import.policy default; the API enforces the configured value

type Phase =
  | { kind: 'idle' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; loaded: number; total: number }
  | { kind: 'creating' }
  | { kind: 'failed'; error: ApiError };

function formatBytes(bytes: number, locale: string): string {
  const mib = bytes / (1024 * 1024);
  return `${new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: mib < 10 ? 2 : 1 }).format(mib)} MiB`;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A03 — upload a ZIP through a constrained upload session, then start the import job. */
function NewImportInner() {
  const { t, locale } = useT();
  const router = useRouter();
  const [tab, setTab] = useState<'zip' | 'github'>('zip');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rights, setRights] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  // One idempotency key per chosen upload so a retried "create import" cannot start two jobs.
  const attempt = useRef<{ sessionId: string; key: string } | null>(null);
  const busy = phase.kind === 'hashing' || phase.kind === 'uploading' || phase.kind === 'creating';

  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  function choose(candidate: File | undefined) {
    setPhase({ kind: 'idle' });
    attempt.current = null;
    if (!candidate) return;
    if (!/\.zip$/i.test(candidate.name)) {
      setFile(null);
      setFileError(t('ui.import.new.error_type'));
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setFile(null);
      setFileError(t('ui.import.new.error_size', { size: formatBytes(MAX_BYTES, locale) }));
      return;
    }
    setFileError(null);
    setFile(candidate);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !rights || busy) return;
    controller.current = new AbortController();
    try {
      if (!attempt.current) {
        setPhase({ kind: 'hashing' });
        const sha256 = await sha256Hex(file);
        const session = await api<{ id: string; upload_url: string }>('/admin/imports/upload-sessions', {
          method: 'POST',
          body: { filename: file.name, size_bytes: file.size, sha256, rights_confirmed: true },
        });
        if (!session.ok) return setPhase({ kind: 'failed', error: session.error });
        setPhase({ kind: 'uploading', loaded: 0, total: file.size });
        const put = await uploadWithProgress(session.data.upload_url, file, (loaded, total) => setPhase({ kind: 'uploading', loaded, total }), controller.current.signal);
        if (put.status !== 200) {
          return setPhase({ kind: 'failed', error: put.body?.error ?? { code: 'internal.error', message: '', field_errors: [], request_id: null, retryable: true } });
        }
        attempt.current = { sessionId: session.data.id, key: crypto.randomUUID() };
      }
      setPhase({ kind: 'creating' });
      const created = await api<{ resource_id: string }>('/admin/imports', {
        method: 'POST',
        body: { upload_session_id: attempt.current.sessionId },
        idempotencyKey: attempt.current.key,
      });
      if (!created.ok) return setPhase({ kind: 'failed', error: created.error });
      router.push(`/admin/imports/${created.data.resource_id}`);
    } catch (error) {
      if ((error as Error).name === 'AbortError') setPhase({ kind: 'idle' });
      else setPhase({ kind: 'failed', error: { code: 'network.unavailable', message: '', field_errors: [], request_id: null, retryable: true } });
    }
  }

  return (
    <div className="stack">
      <h1>{t('ui.import.new.title')}</h1>
      <ImportStepper current={0} />
      <div role="tablist" aria-label={t('ui.import.new.source')} className="row">
        <button type="button" role="tab" aria-selected={tab === 'zip'} className={`button ${tab === 'zip' ? '' : 'button--secondary'}`} onClick={() => setTab('zip')}>
          {t('ui.import.new.tab_zip')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'github'} className={`button ${tab === 'github' ? '' : 'button--secondary'}`} onClick={() => setTab('github')}>
          {t('ui.import.new.tab_github')}
        </button>
      </div>
      {tab === 'github' ? (
        <Alert tone="info" title={t('ui.import.new.github_unavailable_title')}>
          <p>{t('ui.import.new.github_unavailable_body')}</p>
        </Alert>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div
            className="dropzone"
            data-dragging={dragging}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="stack">
              <p style={{ margin: 0 }}><strong>{t('ui.import.new.drop')}</strong></p>
              <label className="button button--secondary" htmlFor="zip-file">{t('ui.import.new.choose')}</label>
              <input
                id="zip-file"
                className="visually-hidden"
                type="file"
                accept=".zip,application/zip"
                aria-describedby="zip-policy zip-error"
                onChange={(e: ChangeEvent<HTMLInputElement>) => choose(e.target.files?.[0])}
                disabled={busy}
              />
              {file ? (
                <p style={{ margin: 0 }}>
                  <span className="mono">{file.name}</span> · {formatBytes(file.size, locale)}
                </p>
              ) : null}
            </div>
          </div>
          <p id="zip-policy" className="field__hint">{t('ui.import.new.policy', { size: formatBytes(MAX_BYTES, locale) })}</p>
          {fileError ? <p id="zip-error" className="field__error" role="alert">{fileError}</p> : null}
          <label className="checkbox">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} disabled={busy} />
            <span>{t('ui.import.new.rights')}</span>
          </label>
          {phase.kind === 'hashing' ? <p role="status">{t('ui.import.new.hashing')}</p> : null}
          {phase.kind === 'uploading' ? (
            <div className="stack" role="status">
              <progress className="progress" max={phase.total} value={phase.loaded} aria-label={t('ui.import.new.uploading')} />
              <span className="tabular">{t('ui.import.new.progress', { loaded: formatBytes(phase.loaded, locale), total: formatBytes(phase.total, locale) })}</span>
            </div>
          ) : null}
          {phase.kind === 'creating' ? <p role="status">{t('ui.import.new.creating')}</p> : null}
          {phase.kind === 'failed' ? <ErrorState error={phase.error} /> : null}
          <div className="row">
            <button type="submit" className="button" disabled={!file || !rights || busy} aria-describedby={!file || !rights ? 'submit-hint' : undefined}>
              {phase.kind === 'failed' && attempt.current ? t('ui.action.retry') : t('ui.import.new.submit')}
            </button>
            {phase.kind === 'uploading' ? (
              <button type="button" className="button button--secondary" onClick={() => controller.current?.abort()}>
                {t('ui.action.cancel')}
              </button>
            ) : null}
          </div>
          {!file || !rights ? <p id="submit-hint" className="field__hint">{t('ui.import.new.submit_hint')}</p> : null}
        </form>
      )}
    </div>
  );
}

export default function NewImport() {
  return (
    <RequirePermission permission="template:import">
      <NewImportInner />
    </RequirePermission>
  );
}
