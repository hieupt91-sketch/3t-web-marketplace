'use client';

import { useId, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import type { ApiError } from '@/lib/api';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE_ICON: Record<Tone, string> = { neutral: '•', info: 'i', success: '✓', warning: '!', error: '×' };

/** Status is always text + icon, never colour alone (docs/05 §3). */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      <span aria-hidden="true">{TONE_ICON[tone]}</span>
      {children}
    </span>
  );
}

export function Alert({ tone, title, children, live }: { tone: Exclude<Tone, 'neutral'>; title?: ReactNode; children?: ReactNode; live?: boolean }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : live ? 'status' : undefined}>
      {title ? <p><strong>{title}</strong></p> : null}
      {children}
    </div>
  );
}

/** Error with request ID for support; no stack traces (docs/05 §3 ErrorState). */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const { t } = useT();
  const message = error.code === 'network.unavailable' ? t('ui.error.network') : error.message || t('error.generic');
  return (
    <Alert tone="error" title={t('ui.error.title')}>
      <p>{message}</p>
      {error.request_id ? (
        <p>
          <small>
            {t('ui.error.request_id')}: <span className="mono">{error.request_id}</span>
          </small>
        </p>
      ) : null}
      {onRetry && error.retryable ? (
        <p>
          <button type="button" className="button button--secondary" onClick={onRetry}>
            {t('ui.action.retry')}
          </button>
        </p>
      ) : null}
    </Alert>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card stack" style={{ textAlign: 'center' }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {children ? <div className="muted">{children}</div> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <p role="status" className="muted">
      {label ?? t('ui.state.loading')}
    </p>
  );
}

/** Label + hint + error wired with aria-describedby. Children receive the generated ids. */
export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint ? (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field__error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Translate a field error code with a generic fallback. */
export function useFieldError() {
  const { t } = useT();
  return (code: string | undefined) => {
    if (!code) return undefined;
    const key = `ui.field_error.${code}`;
    const message = t(key);
    return message === key ? t('ui.field_error.invalid') : message;
  };
}

export function fieldErrorFor(error: ApiError | null, field: string): string | undefined {
  return error?.field_errors.find((f) => f.field === field)?.code;
}
