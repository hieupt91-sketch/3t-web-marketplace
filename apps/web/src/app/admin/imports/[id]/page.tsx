'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { ImportStepper, stepperIndex } from '@/components/import-stepper';
import { ImportConfigureForm } from '@/components/import-configure-form';
import { Alert, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { IMPORT_TERMINAL, importTone, stepTone } from '@/lib/status';

export interface ImportDetail {
  id: string;
  name: string;
  status: string;
  digest: string;
  detected_adapter: string | null;
  confidence: string | null;
  missing_fields: string[];
  detection: { candidates: { adapter: string; projectRoot: string; confidence: string }[]; signals: string[]; reason: string | null; adapter_implemented: boolean | null } | null;
  inspection: { file_count?: number; stripped_prefix?: string | null } | null;
  effective_manifest: Record<string, unknown> | null;
  inferred_fields: string[];
  configuration: { revision: number; overrides: Record<string, unknown> };
  error_code: string | null;
  errors: Record<string, unknown>[];
  steps: { step: string; status: string; started_at: string | null; finished_at: string | null; error_code: string | null }[];
  job: { id: string; status: string; attempts: number; max_attempts: number } | null;
  draft: { template_id: string; version_id: string } | null;
  preview: { url: string; visibility: string } | null;
  screenshots: { id: string; viewport: string | null; url: string }[];
  cancel_requested: boolean;
  created_at: string;
}

interface LogLine {
  id: string;
  step: string | null;
  level: string;
  code: string;
  message: string;
  created_at: string;
}

const STEP_ICON: Record<string, string> = { succeeded: '✓', failed: '×', running: '…', skipped: '–', pending: '○' };

function elapsed(start: string | null, end: string | null): string {
  if (!start) return '';
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function IssueList({ errors }: { errors: Record<string, unknown>[] }) {
  const { t } = useT();
  if (errors.length === 0) return null;
  return (
    <ul>
      {errors.map((issue, index) => {
        const where = (issue.pointer ?? issue.path ?? issue.entry ?? issue.manifest) as string | undefined;
        const code = (issue.code ?? issue.reason ?? issue.rule) as string | undefined;
        const label = code ? t(`ui.issue.${code}`) : '';
        return (
          <li key={index}>
            {where !== undefined ? <span className="mono">{where === '' ? '/' : where}</span> : null}
            {where !== undefined && code ? ' — ' : null}
            {code ? (label === `ui.issue.${code}` ? <span className="mono">{code}</span> : label) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PreviewPanel({ url }: { url: string }) {
  const { t } = useT();
  const [width, setWidth] = useState<'100%' | '768px' | '390px'>('100%');
  return (
    <section className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('ui.import.detail.preview')}</h2>
        <a className="button button--secondary" href={url} target="_blank" rel="noopener noreferrer">{t('ui.import.detail.open_preview')}</a>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.import.detail.preview_note')}</p>
      <div role="group" aria-label={t('ui.import.detail.preview_width')} className="row">
        {(
          [
            ['100%', 'ui.import.detail.width_desktop'],
            ['768px', 'ui.import.detail.width_tablet'],
            ['390px', 'ui.import.detail.width_mobile'],
          ] as const
        ).map(([value, key]) => (
          <button key={value} type="button" className={`button ${width === value ? '' : 'button--secondary'}`} aria-pressed={width === value} onClick={() => setWidth(value)}>
            {t(key)}
          </button>
        ))}
      </div>
      {/* Separate origin + sandbox without allow-same-origin: template code cannot reach portal cookies or storage. */}
      <iframe
        className="preview-frame"
        style={{ maxWidth: width }}
        src={url}
        title={t('ui.import.detail.preview_frame_title')}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </section>
  );
}

function LogsPanel({ importId, active }: { importId: string; active: boolean }) {
  const { t, dt } = useT();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState('');
  const after = useRef('0');

  useEffect(() => {
    let stopped = false;
    async function poll() {
      const res = await api<LogLine[]>(`/admin/imports/${importId}/logs?after=${after.current}&limit=100`);
      if (stopped || !res.ok) return;
      if (res.data.length) {
        after.current = res.data[res.data.length - 1]!.id;
        setLines((prev) => [...prev, ...res.data]);
      }
    }
    void poll();
    const timer = active ? setInterval(() => void poll(), 2500) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [importId, active]);

  const shown = filter ? lines.filter((l) => `${l.code} ${l.message} ${l.step ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : lines;
  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>{t('ui.import.detail.logs')}</h2>
      <label className="field">
        <span>{t('ui.import.detail.logs_filter')}</span>
        <input className="input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <div className="log" tabIndex={0} aria-label={t('ui.import.detail.logs')}>
        {shown.length === 0 ? t('ui.import.detail.logs_empty') : shown.map((l) => `${dt(l.created_at)}  ${l.level.toUpperCase()}  ${l.step ?? '-'}  ${l.code}  ${l.message}`).join('\n')}
      </div>
    </section>
  );
}

function ImportDetailInner() {
  const { t, dt } = useT();
  const me = useCurrentUser();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);
  const retryKey = useRef<string | null>(null);
  const canImport = me.permissions.includes('template:import');

  const load = useCallback(async () => {
    const res = await api<ImportDetail>(`/admin/imports/${id}`);
    if (res.ok) {
      setDetail(res.data);
      setEtag(res.etag);
      setError(null);
    } else setError(res.error);
    return res.ok ? res.data : null;
  }, [id]);

  // Poll with backoff while the pipeline is running; closing the tab does not cancel the job.
  useEffect(() => {
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      const data = await load();
      if (stopped) return;
      if (data && IMPORT_TERMINAL.has(data.status)) return;
      delay = Math.min(delay * 1.5, 5000);
      timer = setTimeout(() => void tick(), delay);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, pollNonce]);

  async function retry() {
    setBusy(true);
    retryKey.current ??= crypto.randomUUID();
    const res = await api(`/admin/imports/${id}/retry`, { method: 'POST', idempotencyKey: retryKey.current });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    retryKey.current = null;
    setActionError(null);
    setPollNonce((n) => n + 1);
  }

  async function cancel() {
    if (!window.confirm(t('ui.import.detail.cancel_confirm', { name: detail?.name ?? '' }))) return;
    setBusy(true);
    const res = await api(`/admin/imports/${id}/cancel`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    await load();
  }

  async function remove() {
    if (!window.confirm(t('ui.import.detail.delete_confirm', { name: detail?.name ?? '' }))) return;
    setBusy(true);
    const res = await api(`/admin/imports/${id}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    router.push('/admin/imports');
  }

  if (error && !detail) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!detail) return <Loading />;

  const running = !IMPORT_TERMINAL.has(detail.status);
  const configurable = canImport && (detail.status === 'needs_configuration' || (detail.status === 'failed' && detail.error_code === 'manifest_invalid'));
  const failedStep = detail.steps.find((s) => s.status === 'failed');

  return (
    <div className="stack">
      <p><Link href="/admin/imports">← {t('ui.admin.imports.title')}</Link></p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{detail.name}</h1>
        <div role="status" aria-live="polite">
          <StatusBadge tone={importTone(detail.status)}>{t(`ui.import.status.${detail.status}`)}</StatusBadge>
        </div>
      </div>
      <ImportStepper current={stepperIndex(detail.status)} failed={['failed', 'rejected'].includes(detail.status)} />

      {running ? (
        <Alert tone="info" title={t('ui.import.detail.auto_title')}>
          <p>{t('ui.import.detail.auto_body')}</p>
        </Alert>
      ) : null}
      {detail.preview ? <PreviewPanel url={detail.preview.url} /> : null}

      {detail.status === 'ready' ? (
        <Alert tone="success" title={t('import.ready')}>
          <p>{t('ui.import.detail.ready_body')}</p>
          <div className="row">
            {detail.preview ? <a className="button" href={detail.preview.url} target="_blank" rel="noopener noreferrer">{t('ui.import.detail.view_demo')}</a> : null}
            <Link className="button button--secondary" href="/admin/templates">{t('ui.import.detail.goto_templates')}</Link>
          </div>
        </Alert>
      ) : null}
      {detail.error_code ? (
        <Alert tone={detail.status === 'needs_configuration' ? 'warning' : 'error'} title={t(`ui.import.error.${detail.error_code}`)}>
          {failedStep ? <p>{t('ui.import.detail.failed_step', { step: t(`ui.import.step.${failedStep.step}`) })}</p> : null}
          <IssueList errors={detail.errors} />
          {detail.status === 'queued' ? <p>{t('ui.import.detail.retry_scheduled')}</p> : null}
        </Alert>
      ) : null}
      {actionError ? <ErrorState error={actionError} /> : null}

      <div className="row">
        {canImport && detail.status === 'failed' ? (
          <button type="button" className="button" onClick={() => void retry()} disabled={busy}>{t('ui.action.retry')}</button>
        ) : null}
        {canImport && running && !detail.cancel_requested ? (
          <button type="button" className="button button--danger" onClick={() => void cancel()} disabled={busy}>{t('ui.import.detail.cancel')}</button>
        ) : null}
        {canImport && (detail.status === 'failed' || detail.status === 'cancelled' || detail.status === 'rejected') ? (
          <button type="button" className="button button--danger" onClick={() => void remove()} disabled={busy}>{t('ui.import.detail.delete')}</button>
        ) : null}
        {detail.cancel_requested && running ? <StatusBadge tone="warning">{t('ui.import.detail.cancelling')}</StatusBadge> : null}
      </div>

      {configurable && etag ? <ImportConfigureForm detail={detail} etag={etag} onSaved={() => setPollNonce((n) => n + 1)} reload={load} /> : null}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t('ui.import.detail.detection')}</h2>
        <dl className="details">
          <dt>{t('ui.import.detail.adapter')}</dt>
          <dd>{detail.detected_adapter ?? '—'}</dd>
          <dt>{t('ui.import.detail.confidence')}</dt>
          <dd>{detail.confidence ? t(`ui.import.confidence.${detail.confidence}`) : '—'}</dd>
          <dt>{t('ui.import.detail.files')}</dt>
          <dd className="tabular">{detail.inspection?.file_count ?? '—'}</dd>
          <dt>{t('ui.import.detail.digest')}</dt>
          <dd className="mono">{detail.digest}</dd>
          <dt>{t('ui.import.detail.created')}</dt>
          <dd className="tabular">{dt(detail.created_at)}</dd>
        </dl>
        {detail.detection?.adapter_implemented === false ? (
          <Alert tone="warning"><p>{t('ui.import.detail.adapter_not_implemented', { adapter: detail.detected_adapter ?? '' })}</p></Alert>
        ) : null}
        {detail.missing_fields.length ? (
          <div>
            <h3>{t('ui.import.detail.missing_fields')}</h3>
            <ul>{detail.missing_fields.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
          </div>
        ) : null}
        {detail.inferred_fields.length ? <p className="muted">{t('ui.import.detail.inferred', { fields: detail.inferred_fields.join(', ') })}</p> : null}
        {detail.detection && detail.detection.candidates.length > 1 ? (
          <div>
            <h3>{t('ui.import.detail.candidates')}</h3>
            <ul>
              {detail.detection.candidates.map((c) => (
                <li key={`${c.adapter}:${c.projectRoot}`}>
                  <span className="mono">{c.adapter}</span> · <span className="mono">{c.projectRoot || '/'}</span> · {t(`ui.import.confidence.${c.confidence}`)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {detail.detection && detail.detection.signals.length ? (
          <p className="muted">{t('ui.import.detail.signals')}: {detail.detection.signals.join(', ')}</p>
        ) : null}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t('ui.import.detail.timeline')}</h2>
        <ol className="timeline">
          {detail.steps.map((s) => (
            <li key={s.step}>
              <span className="timeline__icon" style={{ color: `var(--color-${stepTone(s.status) === 'error' ? 'danger' : stepTone(s.status) === 'success' ? 'success' : stepTone(s.status) === 'info' ? 'info' : 'text-muted'})` }} aria-hidden="true">
                {STEP_ICON[s.status] ?? '○'}
              </span>
              <span>
                {t(`ui.import.step.${s.step}`)} <span className="visually-hidden">— {t(`ui.step.status.${s.status}`)}</span>
                {s.error_code ? <span className="field__error"> · {t(`ui.import.error.${s.error_code}`)}</span> : null}
                {s.status === 'skipped' ? <span className="muted"> · {t('ui.step.status.skipped')}</span> : null}
              </span>
              <span className="muted tabular">{elapsed(s.started_at, s.finished_at)}</span>
            </li>
          ))}
        </ol>
        {detail.job ? <p className="muted" style={{ margin: 0 }}>{t('ui.import.detail.attempts', { attempts: detail.job.attempts, max: detail.job.max_attempts })}</p> : null}
      </section>

      {detail.screenshots.length ? (
        <section className="card stack">
          <h2 style={{ margin: 0 }}>{t('ui.import.detail.screenshots')}</h2>
          <div className="grid-cards">
            {detail.screenshots.map((s) => (
              <figure key={s.id} style={{ margin: 0 }}>
                <img src={s.url} alt={t('ui.import.detail.screenshot_alt', { viewport: s.viewport ?? '' })} style={{ width: '100%', border: '1px solid var(--color-border)', borderRadius: 8 }} />
                <figcaption className="muted">{s.viewport}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {detail.effective_manifest ? (
        <details className="card">
          <summary>{t('ui.import.detail.manifest')}</summary>
          <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
            <div>
              <button type="button" className="button button--secondary" onClick={() => void navigator.clipboard.writeText(JSON.stringify(detail.effective_manifest, null, 2))}>
                {t('ui.action.copy')}
              </button>
            </div>
            <pre className="code">{JSON.stringify(detail.effective_manifest, null, 2)}</pre>
          </div>
        </details>
      ) : null}

      <LogsPanel importId={detail.id} active={running} />
    </div>
  );
}

export default function ImportDetailPage() {
  return (
    <RequirePermission permission="template:read">
      <ImportDetailInner />
    </RequirePermission>
  );
}
