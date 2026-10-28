'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, ErrorState, FormField, Loading } from '@/components/ui';
import { PasswordInput } from '@/components/password-input';
import { api, safeReturnPath, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { Me } from '@/lib/use-me';

function LoginForm() {
  const { t } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeReturnPath(params.get('next'));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api('/auth/login', { method: 'POST', body: { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') } });
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    const me = await api<Me>('/me');
    if (me.ok) document.cookie = `mp_locale=${me.data.locale}; path=/; max-age=31536000; samesite=lax`;
    router.replace(next);
    router.refresh();
  }

  return (
    <form className="stack card" onSubmit={submit}>
      <h1>{t('ui.auth.login.title')}</h1>
      {params.get('reason') === 'expired' ? <Alert tone="warning"><p>{t('error.auth.session_expired')}</p></Alert> : null}
      {params.get('reason') === 'reset' ? <Alert tone="success"><p>{t('ui.auth.reset.done_body')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <FormField label={t('ui.auth.field.email')}>
        {(p) => <input {...p} name="email" type="email" className="input" autoComplete="username" required />}
      </FormField>
      <FormField label={t('ui.auth.field.password')}>
        {(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required />}
      </FormField>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>
          {busy ? t('ui.state.saving') : t('ui.auth.login.submit')}
        </button>
        <Link href="/auth/forgot-password">{t('ui.auth.login.forgot')}</Link>
        <Link href="/auth/register">{t('ui.auth.login.create')}</Link>
      </div>
    </form>
  );
}

/** U02 — sign in with a safe internal return path. */
export default function LoginPage() {
  return (
    <Suspense fallback={<Loading />}>
      <LoginForm />
    </Suspense>
  );
}
