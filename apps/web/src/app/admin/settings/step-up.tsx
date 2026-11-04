'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorState } from '@/components/ui';
import { api, type ApiError, type ApiResult } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * Inline step-up for settings forms whose POSTs require fresh
 * re-authentication. Before this helper, such a save simply failed with
 * `auth.step_up_required` and stranded the user on a bare error (hit live
 * on the Email settings page). Usage: give the hook the form's save thunk
 * and await `submit()` instead of calling `api()` directly —
 *
 *   const doSave = async () => api<Settings>(path, { method: 'POST', body });
 *   const stepUp = useStepUp(doSave);
 *   const res = await stepUp.submit();   // in the form's submit handler
 *   ...render {stepUp.prompt} with the form's other feedback...
 *
 * `submit()` runs the thunk; on a step-up error it opens the prompt and
 * stays pending. A correct password (POST /auth/step-up, 10-minute
 * elevation) retries the thunk exactly once — the hook always invokes the
 * latest render's thunk, so the retry carries the form's current values.
 * A wrong password shows its error inside the prompt for another try.
 * Cancel settles the pending `submit()` with the original step-up error,
 * so the form falls back to its plain error state.
 */
export function useStepUp<T>(perform: () => Promise<ApiResult<T>>): {
  submit: () => Promise<ApiResult<T>>;
  prompt: ReactNode;
} {
  const { t } = useT();
  const performRef = useRef(perform);
  useEffect(() => {
    performRef.current = perform;
  });
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const waitersRef = useRef<Array<(result: ApiResult<T>) => void>>([]);
  const originalRef = useRef<(ApiResult<T> & { ok: false }) | null>(null);

  function settle(result: ApiResult<T>) {
    originalRef.current = null;
    setOpen(false);
    setPassword('');
    setAuthError(null);
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const resolve of waiters) resolve(result);
  }

  async function submit(): Promise<ApiResult<T>> {
    const first = await performRef.current();
    if (first.ok || first.error.code !== 'auth.step_up_required') return first;
    originalRef.current = first;
    setAuthError(null);
    setPassword('');
    setOpen(true);
    return new Promise<ApiResult<T>>((resolve) => {
      waitersRef.current.push(resolve);
    });
  }

  async function confirm() {
    if (authBusy) return;
    setAuthBusy(true);
    const up = await api('/auth/step-up', { method: 'POST', body: { password } });
    if (!up.ok) {
      setAuthBusy(false);
      setAuthError(up.error);
      return;
    }
    // Elevated: retry the original submission exactly once.
    const second = await performRef.current();
    setAuthBusy(false);
    settle(second);
  }

  function cancel() {
    if (authBusy) return;
    const original = originalRef.current;
    if (original) settle(original);
  }

  const prompt = open ? (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{t('ui.step_up.title')}</h3>
      <p className="muted" style={{ margin: 0 }}>{t('ui.step_up.hint')}</p>
      {authError ? <ErrorState error={authError} /> : null}
      <label className="field">
        <span>{t('ui.mfa.step_up_password')}</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={authBusy}
          autoComplete="current-password"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void confirm();
            }
          }}
        />
      </label>
      <div className="row">
        <button type="button" className="button" disabled={authBusy} onClick={() => void confirm()}>
          {t('ui.step_up.confirm')}
        </button>
        <button type="button" className="button button--secondary" disabled={authBusy} onClick={cancel}>
          {t('ui.action.cancel')}
        </button>
      </div>
    </div>
  ) : null;

  return { submit, prompt };
}
