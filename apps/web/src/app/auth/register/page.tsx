'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, ErrorState, FormField, Loading, fieldErrorFor, useFieldError } from '@/components/ui';
import { PasswordInput } from '@/components/password-input';
import { api, safeReturnPath, AUTH_NEXT_KEY, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Where an interrupted journey (e.g. checkout) resumes after sign-up: the
 * return path rides the register → verify → login chain. It is carried in the
 * URL between register and login, and in localStorage across the email
 * verification hop (the verification link opens without our query string). */
function RegisterForm() {
  const { t, locale } = useT();
  const params = useSearchParams();
  const fieldError = useFieldError();
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const rawNext = params.get('next');
  const next = safeReturnPath(rawNext);
  const carry = rawNext !== null && next === rawNext;
  const nextQuery = carry ? `?next=${encodeURIComponent(next)}` : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api('/auth/register', {
      method: 'POST',
      body: {
        display_name: String(form.get('display_name') ?? ''),
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        locale: String(form.get('locale') ?? locale),
        accept_terms: form.get('accept_terms') === 'on',
      },
    });
    setBusy(false);
    if (res.ok) {
      if (carry) {
        try {
          window.localStorage.setItem(AUTH_NEXT_KEY, next);
        } catch {
          /* storage unavailable: the done screen still links onward with ?next= */
        }
      }
      setDone(true);
    } else setError(res.error);
  }

  if (done) {
    return (
      <div className="stack">
        <h1>{t('ui.auth.register.done_title')}</h1>
        <Alert tone="success" live>
          <p>{t('ui.auth.register.done_body')}</p>
        </Alert>
        <p>
          <Link href="/auth/verify">{t('ui.auth.verify.resend_link')}</Link>
        </p>
        {carry ? (
          <p>
            <Link href={`/auth/login${nextQuery}`}>{t('ui.auth.register.have_account')}</Link>
          </p>
        ) : null}
      </div>
    );
  }

  const isValidation = error?.code === 'validation.failed';
  return (
    <form className="stack card" onSubmit={submit} noValidate>
      <h1>{t('ui.auth.register.title')}</h1>
      {error && !isValidation ? <ErrorState error={error} /> : null}
      {isValidation ? (
        <Alert tone="error" title={t('error.validation.failed')}>
          <ul>
            {error!.field_errors.map((f) => (
              <li key={`${f.field}-${f.code}`}>
                <a href={`#field-${f.field}`}>{t(`ui.auth.field.${f.field}`)}</a>: {fieldError(f.code)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <FormField id="field-display_name" label={t('ui.auth.field.display_name')} error={fieldError(fieldErrorFor(error, 'display_name'))}>
        {(p) => <input {...p} name="display_name" className="input" autoComplete="name" required maxLength={120} />}
      </FormField>
      <FormField id="field-email" label={t('ui.auth.field.email')} error={fieldError(fieldErrorFor(error, 'email'))}>
        {(p) => <input {...p} name="email" type="email" className="input" autoComplete="email" required />}
      </FormField>
      <FormField id="field-password" label={t('ui.auth.field.password')} hint={t('ui.auth.password_policy')} error={fieldError(fieldErrorFor(error, 'password'))}>
        {(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={12} maxLength={128} />}
      </FormField>
      <FormField label={t('ui.auth.field.locale')}>
        {(p) => (
          <select {...p} name="locale" className="select" defaultValue={locale}>
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        )}
      </FormField>
      <label className="checkbox" id="field-accept_terms">
        <input type="checkbox" name="accept_terms" required aria-invalid={fieldErrorFor(error, 'accept_terms') ? true : undefined} />
        <span>{t('ui.auth.accept_terms')}</span>
      </label>
      <div className="row">
        <button type="submit" className="button" disabled={busy}>
          {busy ? t('ui.state.saving') : t('ui.auth.register.submit')}
        </button>
        <Link href={`/auth/login${nextQuery}`}>{t('ui.auth.register.have_account')}</Link>
      </div>
    </form>
  );
}

/** U01 — registration. The response never reveals whether the email already exists. */
export default function RegisterPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RegisterForm />
    </Suspense>
  );
}
