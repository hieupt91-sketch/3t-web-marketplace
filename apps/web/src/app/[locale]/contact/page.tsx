'use client';

import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, ErrorState, FormField, fieldErrorFor, useFieldError } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** P09 — contact form. Success never implies an order was created (docs/05 P09). */
export default function ContactPage() {
  const { t } = useT();
  const fieldError = useFieldError();
  const params = useParams<{ locale: string }>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api(`/contact-requests?locale=${params.locale}`, {
      method: 'POST',
      body: {
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        body: String(form.get('body') ?? ''),
        consent: form.get('consent') === 'on',
        website: String(form.get('website') ?? ''),
      },
    });
    setBusy(false);
    if (res.ok) setSent(true);
    else setError(res.error);
  }

  return (
    <div className="container container--form stack">
      <h1>{t('ui.contact.title')}</h1>
      <p className="muted">{t('ui.contact.lead')}</p>
      {sent ? (
        <Alert tone="success" live><p>{t('ui.contact.sent')}</p></Alert>
      ) : (
        <form className="card stack" onSubmit={submit}>
          {error ? <ErrorState error={error} /> : null}
          <FormField label={t('ui.contact.name')} error={fieldError(fieldErrorFor(error, 'name'))}>
            {(p) => <input {...p} className="input" name="name" autoComplete="name" required maxLength={200} />}
          </FormField>
          <FormField label={t('ui.auth.field.email')} error={fieldError(fieldErrorFor(error, 'email'))}>
            {(p) => <input {...p} className="input" name="email" type="email" autoComplete="email" required />}
          </FormField>
          <FormField label={t('ui.contact.message')} error={fieldError(fieldErrorFor(error, 'body'))}>
            {(p) => <textarea {...p} className="textarea" name="body" rows={5} required maxLength={5000} />}
          </FormField>
          {/* Honeypot: hidden from people, tempting to bots. */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }}>
            <label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" /></label>
          </div>
          <label className="checkbox">
            <input type="checkbox" name="consent" required aria-invalid={fieldErrorFor(error, 'consent') ? true : undefined} />
            <span>{t('ui.contact.consent')}</span>
          </label>
          <div>
            <button type="submit" className="button" disabled={busy}>{busy ? t('ui.state.saving') : t('ui.contact.submit')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
