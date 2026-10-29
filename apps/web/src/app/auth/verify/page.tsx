'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { ResendVerification } from '@/components/resend-verification';
import { api, safeReturnPath, AUTH_NEXT_KEY, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useUrlToken } from '@/lib/use-url-token';

type State = { kind: 'idle' } | { kind: 'verifying' } | { kind: 'verified' } | { kind: 'failed'; error: ApiError };

/** U03 — consume the verification token once; used/expired/invalid states are distinct. */
export default function VerifyPage() {
  const { t } = useT();
  const { token, ready } = useUrlToken();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const started = useRef(false);

  // Registration may have stashed a return path (e.g. back to checkout):
  // offer to continue there via login once the email is verified.
  useEffect(() => {
    if (state.kind !== 'verified') return;
    try {
      const stored = window.localStorage.getItem(AUTH_NEXT_KEY);
      if (stored) {
        window.localStorage.removeItem(AUTH_NEXT_KEY);
        setReturnPath(safeReturnPath(stored));
      }
    } catch {
      /* storage unavailable */
    }
  }, [state.kind]);

  useEffect(() => {
    if (!ready || !token || started.current) return;
    started.current = true;
    setState({ kind: 'verifying' });
    void api('/auth/verify-email', { method: 'POST', body: { token } }).then((res) =>
      setState(res.ok ? { kind: 'verified' } : { kind: 'failed', error: res.error }),
    );
  }, [ready, token]);

  return (
    <div className="stack card">
      <h1>{t('ui.auth.verify.title')}</h1>
      {!ready || state.kind === 'verifying' ? <Loading label={t('ui.auth.verify.verifying')} /> : null}
      {state.kind === 'verified' ? (
        <Alert tone="success" live>
          <p>{t('ui.auth.verify.success')}</p>
          {returnPath ? (
            <p><Link className="button" href={`/auth/login?next=${encodeURIComponent(returnPath)}`}>{t('ui.auth.verify.continue')}</Link></p>
          ) : null}
          <p><Link href="/account">{t('ui.nav.account')}</Link></p>
        </Alert>
      ) : null}
      {state.kind === 'failed' ? <ErrorState error={state.error} /> : null}
      {ready && !token && state.kind === 'idle' ? <p className="muted">{t('ui.auth.verify.check_inbox')}</p> : null}
      {state.kind !== 'verified' && state.kind !== 'verifying' && ready ? <ResendVerification /> : null}
    </div>
  );
}
