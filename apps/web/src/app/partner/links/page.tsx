'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
export default function PartnerLinks() {
  const { t } = useT();
  const [slug, setSlug] = useState('');
  const [locale, setLocale] = useState('vi');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await api<{ url: string }>('/partner/demo-links', { method: 'POST', body: { template_slug: slug, locale } });
    if (!res.ok) return setError(res.error);
    setUrl(res.data.url);
  }
  return (
    <div className="stack">
      <h1>{t('ui.partner.links')}</h1>
      {error ? <ErrorState error={error} /> : null}
      <form onSubmit={submit} className="stack">
        <label>{t('ui.partner.display_name')}<input value={slug} onChange={(e) => setSlug(e.target.value)} required placeholder="template-slug" /></label>
        <label>{t('ui.partner.settings')}<select value={locale} onChange={(e) => setLocale(e.target.value)}><option value="vi">vi</option><option value="en">en</option></select></label>
        <button className="button">{t('ui.partner.links')}</button>
      </form>
      {url ? <p className="mono">{url}</p> : null}
    </div>
  );
}
