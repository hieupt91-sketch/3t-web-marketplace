'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface SessionItem {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  current: boolean;
}

/** U06 — devices and session revocation, MFA (TOTP), step-up, password change. */
export default function SecurityPage() {
  const { t, dt } = useT();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<SessionItem[]>('/me/sessions');
    if (res.ok) setSessions(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(session: SessionItem) {
    setPending(session.id);
    const res = await api(`/me/sessions/${session.id}`, { method: 'DELETE' });
    setPending(null);
    if (!res.ok) return setError(res.error);
    if (session.current) {
      router.replace('/auth/login');
      return;
    }
    await load();
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    router.replace('/auth/login');
    router.refresh();
  }



  return (
    <div className="stack">
      <h1>{t('ui.account.security.title')}</h1>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      <section className="stack">
        <h2>{t('ui.account.security.sessions')}</h2>
        {!sessions && !error ? <Loading /> : null}
        {sessions ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('ui.account.security.device')}</th>
                  <th scope="col">{t('ui.account.security.last_active')}</th>
                  <th scope="col"><span className="visually-hidden">{t('ui.table.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="mono">{s.user_agent ?? t('ui.account.security.unknown_device')}</span>{' '}
                      {s.current ? <StatusBadge tone="info">{t('ui.account.security.current')}</StatusBadge> : null}
                    </td>
                    <td className="tabular">{dt(s.last_active_at)}</td>
                    <td>
                      <button type="button" className="button button--danger" disabled={pending === s.id} onClick={() => void revoke(s)}>
                        {s.current ? t('ui.account.security.revoke_current') : t('ui.account.security.revoke')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="stack">
        <h2>{t('ui.account.security.password')}</h2>
        <p className="muted">{t('ui.account.security.password_body')}</p>
        <p><Link href="/auth/forgot-password">{t('ui.auth.forgot.title')}</Link></p>
        <MfaSection />
      </section>
      <div>
        <button type="button" className="button button--secondary" onClick={() => void logout()}>{t('ui.nav.logout')}</button>
      </div>
    </div>
  );
}

function MfaSection() {
    const { t: tt } = useT();
    const [enabled, setEnabled] = useState<boolean | null>(null);
    const [secret, setSecret] = useState<string | null>(null);
    const [uri, setUri] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
    const [password, setPassword] = useState('');
    const [mfaError, setMfaError] = useState<ApiError | null>(null);
    const refresh = useCallback(async () => {
      const res = await api<{ enabled: boolean }>('/me/mfa');
      if (res.ok) setEnabled(res.data.enabled);
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    async function stepUp() {
      const res = await api('/auth/step-up', { method: 'POST', body: { password } });
      if (!res.ok) return setMfaError(res.error);
      setMfaError(null);
    }
    async function setup() {
      const res = await api<{ secret: string; otpauth_uri: string }>('/me/mfa/setup', { method: 'POST', body: {} });
      if (!res.ok) return setMfaError(res.error);
      setSecret(res.data.secret); setUri(res.data.otpauth_uri);
    }
    async function verify() {
      const res = await api<{ backup_codes: string[] }>('/me/mfa/verify', { method: 'POST', body: { code } });
      if (!res.ok) return setMfaError(res.error);
      setBackupCodes(res.data.backup_codes); void refresh();
    }
    async function disable() {
      const res = await api('/me/mfa/disable', { method: 'POST', body: {} });
      if (!res.ok) return setMfaError(res.error);
      void refresh();
    }
    return (
      <div className="stack">
        <h3>{tt('ui.mfa.title')}</h3>
        {mfaError ? <ErrorState error={mfaError} /> : null}
        <p>{enabled === null ? '' : enabled ? tt('ui.mfa.enabled') : tt('ui.mfa.disabled')}</p>
        <label>{tt('ui.mfa.step_up_password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="button button--secondary" onClick={() => void stepUp()}>{tt('ui.mfa.step_up')}</button>
        {!enabled ? <button className="button" onClick={() => void setup()}>{tt('ui.mfa.setup')}</button> : null}
        {secret ? <p className="mono">{secret}<br /><span>{uri}</span></p> : null}
        {secret ? (<><label>{tt('ui.mfa.code')}<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label><button className="button" onClick={() => void verify()}>{tt('ui.mfa.verify')}</button></>) : null}
        {backupCodes ? <p role="status">{tt('ui.mfa.backup_codes')}: {backupCodes.join(', ')}</p> : null}
        {enabled ? <button className="button button--danger" onClick={() => void disable()}>{tt('ui.mfa.disable')}</button> : null}
      </div>
    );

}
