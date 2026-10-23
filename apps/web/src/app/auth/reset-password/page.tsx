'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, ErrorState, FormField, Loading, fieldErrorFor, useFieldError } from '@/components/ui';
import { PasswordInput } from '@/components/password-input';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useUrlToken } from '@/lib/use-url-token';

/** U05 — set a new password; success signs out other devices and leads to login. */
export default function ResetPasswordPage() {
  const { t } = useT();
  const fieldError = useFieldError();
  const router = useRouter();
  const { token, ready } = useUrlToken();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const checks = [
    { ok: [...password].length >= 12, label: t('ui.auth.reset.check_length') },
    { ok: password.length > 0 && password === confirm, label: t('ui.auth.reset.check_match') },
  ];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !token || checks.some((c) => !c.ok)) return;
    setBusy(true);
    setError(null);
    const res = await api('/auth/reset-password', { method: 'POST', body: { token, password } });
    setBusy(false);
    if (res.ok) router.replace('/auth/login?reason=reset');
    else setError(res.error);
  }

  if (!ready) return <Loading />;
  if (!token) {
    return (
      <div className="stack card">
        <h1>{t('ui.auth.reset.title')}</h1>
        <Alert tone="warning"><p>{t('error.auth.token_invalid')}</p></Alert>
        <Link href="/auth/forgot-password">{t('ui.auth.forgot.title')}</Link>
      </div>
    );
  }
  return (
    <form className="stack card" onSubmit={submit}>
      <h1>{t('ui.auth.reset.title')}</h1>
      {error ? <ErrorState error={error} /> : null}
      {error && error.code.startsWith('auth.token') ? <Link href="/auth/forgot-password">{t('ui.auth.forgot.title')}</Link> : null}
      <FormField label={t('ui.auth.field.new_password')} error={fieldError(fieldErrorFor(error, 'password'))}>
        {(p) => <PasswordInput {...p} name="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
      </FormField>
      <FormField label={t('ui.auth.field.confirm_password')}>
        {(p) => <PasswordInput {...p} name="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
      </FormField>
      <ul aria-label={t('ui.auth.reset.checklist')}>
        {checks.map((c) => (
          <li key={c.label}>
            <span aria-hidden="true">{c.ok ? '✓' : '○'}</span> {c.label} <span className="visually-hidden">{c.ok ? t('ui.state.done') : t('ui.state.not_done')}</span>
          </li>
        ))}
      </ul>
      <div>
        <button className="button" type="submit" disabled={busy || checks.some((c) => !c.ok)}>{t('ui.auth.reset.submit')}</button>
      </div>
    </form>
  );
}
