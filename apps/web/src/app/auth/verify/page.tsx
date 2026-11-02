'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { ResendVerification } from '@/components/resend-verification';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useUrlToken } from '@/lib/use-url-token';

type State = { kind: 'idle' } | { kind: 'verifying' } | { kind: 'verified' } | { kind: 'failed'; error: ApiError };

/** U03 — consume the verification token once; used/expired/invalid states are distinct. */
export default function VerifyPage() {
  const { t } = useT();
  const { token, ready } = useUrlToken();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const started = useRef(false);

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
          <p><Link href="/account">{t('ui.nav.account')}</Link></p>
        </Alert>
      ) : null}
      {state.kind === 'failed' ? <ErrorState error={state.error} /> : null}
      {ready && !token && state.kind === 'idle' ? <p className="muted">{t('ui.auth.verify.check_inbox')}</p> : null}
      {state.kind !== 'verified' && state.kind !== 'verifying' && ready ? <ResendVerification /> : null}
    </div>
  );
}
