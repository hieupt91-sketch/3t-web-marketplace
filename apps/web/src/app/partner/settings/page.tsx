'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
export default function PartnerSettings() {
  const { t } = useT();
  const [locale, setLocale] = useState('vi');
  const [timezone, setTimezone] = useState('Asia/Ho_Chi_Minh');
  const [domains, setDomains] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await api('/partner/settings', { method: 'POST', body: { locale, timezone, return_domains: domains.split(',').map((d) => d.trim()).filter(Boolean) } });
    if (!res.ok) return setError(res.error);
    setDone(true);
  }
  return (
    <div className="stack">
      <h1>{t('ui.partner.settings')}</h1>
      {error ? <ErrorState error={error} /> : null}
      {done ? <p role="status">OK</p> : null}
      <form onSubmit={submit} className="stack">
        <label>{t('ui.partner.settings')}<select value={locale} onChange={(e) => setLocale(e.target.value)}><option value="vi">vi</option><option value="en">en</option></select></label>
        <label>{t('ui.partner.settings')}<input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
        <label>return_domains (comma-separated)<input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="partner.example" /></label>
        <button className="button">{t('ui.partner.settings')}</button>
      </form>
    </div>
  );
}
