'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useRouter } from 'next/navigation';

export default function PartnerApply() {
  const { t } = useT();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [channel, setChannel] = useState('');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const res = await api('/partner/apply', { method: 'POST', body: { display_name: displayName, channel, domain, description } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push('/partner');
  }
  return (
    <div className="stack">
      <h1>{t('ui.partner.apply')}</h1>
      <p>{t('ui.partner.apply_help')}</p>
      {error ? <ErrorState error={error} /> : null}
      <form onSubmit={submit} className="stack">
        <label>{t('ui.partner.display_name')}<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label>
        <label>{t('ui.partner.channel')}<input value={channel} onChange={(e) => setChannel(e.target.value)} required /></label>
        <label>{t('ui.partner.domain')}<input value={domain} onChange={(e) => setDomain(e.target.value)} required /></label>
        <label>{t('ui.partner.description')}<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <button className="button" disabled={busy}>{t('ui.partner.apply')}</button>
      </form>
    </div>
  );
}
