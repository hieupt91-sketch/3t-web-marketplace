'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Channels { phone: string; zalo: string; messenger: string; email: string }

function ContactInner() {
  const { t } = useT();
  const [channels, setChannels] = useState<Channels | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Channels>('/admin/settings/contact').then((res) => {
      if (res.ok) setChannels(res.data);
      else setError(res.error);
    });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!channels || busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    const res = await api<Channels>('/admin/settings/contact', { method: 'POST', body: channels });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setChannels(res.data);
      setSaved(true);
    }
  }

  if (error && !channels) return <ErrorState error={error} />;
  if (!channels) return <Loading />;

  const fields: [keyof Channels, string][] = [
    ['phone', 'ui.contact.field_phone'],
    ['zalo', 'ui.contact.field_zalo'],
    ['messenger', 'ui.contact.field_messenger'],
    ['email', 'ui.contact.field_email'],
  ];
  return (
    <div className="stack">
      <h1>{t('ui.contact.settings_title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.contact.settings_hint')}</p>
      {saved ? <Alert tone="success"><p>{t('ui.contact.saved')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <form className="stack card" onSubmit={submit}>
        {fields.map(([key, labelKey]) => (
          <label className="field" key={key}>
            <span>{t(labelKey)}</span>
            <input
              className="input"
              value={channels[key]}
              onChange={(e) => setChannels({ ...channels, [key]: e.target.value })}
              disabled={busy}
              autoComplete="off"
            />
          </label>
        ))}
        <div className="row">
          <button type="submit" className="button" disabled={busy}>{t('ui.action.save')}</button>
        </div>
      </form>
    </div>
  );
}

export default function ContactSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <ContactInner />
    </RequirePermission>
  );
}
