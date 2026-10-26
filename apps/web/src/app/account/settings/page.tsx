'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Me { display_name: string; locale: string; timezone: string }

/** C13 — settings: name, locale, timezone. Dirty form; locale change keeps the resource. */
export default function SettingsPage() {
  const { t } = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [name, setName] = useState('');
  const [locale, setLocale] = useState('vi');
  const [timezone, setTimezone] = useState('Asia/Ho_Chi_Minh');
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    const res = await api<Me>('/me');
    if (res.ok) {
      setMe(res.data);
      setEtag(res.etag);
      setName(res.data.display_name);
      setLocale(res.data.locale);
      setTimezone(res.data.timezone);
    } else setError(res.error);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const dirty = me !== null && (name !== me.display_name || locale !== me.locale || timezone !== me.timezone);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void api('/me', { method: 'PATCH', ifMatch: etag, body: { display_name: name, locale, timezone } }).then((res) => {
      if (!res.ok) setError(res.error); else { setSaved(true); void load(); }
    });
  };
  if (error && !me) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!me) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.settings.title')}</h1>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>{t('ui.settings.display_name')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></label>
        <label className="field">
          <span>{t('ui.settings.locale')}</span>
          <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field"><span>{t('ui.settings.timezone')}</span><input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} required /></label>
        <p className="muted" style={{ margin: 0 }}>{t('ui.settings.currency_note')}</p>
        <div className="row"><button className="button" type="submit" disabled={!dirty}>{t('ui.settings.save')}</button>{saved ? <span role="status">{t('ui.settings.saved')}</span> : null}</div>
      </form>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
    </div>
  );
}
