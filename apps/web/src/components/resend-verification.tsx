'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Alert, FormField } from './ui';

const COOLDOWN_SECONDS = 60;

export function ResendVerification() {
  const { t } = useT();
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cooldown > 0) return;
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    await api('/auth/resend-verification', { method: 'POST', body: { email } });
    setSent(true);
    setCooldown(COOLDOWN_SECONDS);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>{t('ui.auth.verify.resend_title')}</h2>
      {sent ? <Alert tone="info" live><p>{t('ui.auth.generic_sent')}</p></Alert> : null}
      <FormField label={t('ui.auth.field.email')}>
        {(p) => <input {...p} name="email" type="email" className="input" autoComplete="email" required />}
      </FormField>
      <div>
        <button type="submit" className="button button--secondary" disabled={cooldown > 0} aria-describedby={cooldown > 0 ? 'resend-cooldown' : undefined}>
          {t('ui.auth.verify.resend_action')}
        </button>
        {cooldown > 0 ? <p id="resend-cooldown" className="field__hint">{t('ui.auth.verify.cooldown', { seconds: cooldown })}</p> : null}
      </div>
    </form>
  );
}
