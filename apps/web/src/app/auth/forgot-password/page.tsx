'use client';

import { useState, type FormEvent } from 'react';
import { Alert, ErrorState, FormField } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** U04 — identical answer whether or not the account exists. */
export default function ForgotPasswordPage() {
  const { t } = useT();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await api('/auth/forgot-password', { method: 'POST', body: { email: String(new FormData(event.currentTarget).get('email') ?? '') } });
    setBusy(false);
    if (res.ok) setSent(true);
    else setError(res.error);
  }

  return (
    <form className="stack card" onSubmit={submit}>
      <h1>{t('ui.auth.forgot.title')}</h1>
      <p className="muted">{t('ui.auth.forgot.lead')}</p>
      {sent ? <Alert tone="info" live><p>{t('ui.auth.generic_sent')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <FormField label={t('ui.auth.field.email')}>
        {(p) => <input {...p} name="email" type="email" className="input" autoComplete="email" required />}
      </FormField>
      <div>
        <button className="button" type="submit" disabled={busy}>{t('ui.auth.forgot.submit')}</button>
      </div>
    </form>
  );
}
