'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface SiteLite { id: string; display_name: string; subdomain: string | null; domain_paid_until?: string | null }
interface PublicConfig { site_base_domain?: string; currency?: string; subdomain_fee?: { amount_minor: number | null; period: string } | null }

/** The domain package on its own: buy or renew just the name for a site
 *  that already exists. Prices come only from the owner's settings; a
 *  period the owner has not priced is never offered. */
function DomainBuy() {
  const { t, dt, locale } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const siteId = params.get('site') ?? '';
  const [site, setSite] = useState<SiteLite | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    void api<SiteLite>(`/sites/${siteId}`).then((res) => { if (res.ok) setSite(res.data); else setError(res.error); });
    void api<PublicConfig>('/config/public').then((res) => { if (res.ok) setConfig(res.data); });
  }, [siteId]);

  if (!siteId) return <p className="muted">{t('ui.checkout.domain.no_site')}</p>;
  if (error && !site) return <ErrorState error={error} />;
  if (!site || !config) return <Loading />;

  const fee = config.subdomain_fee;
  const baseDomain = config.site_base_domain ?? 'webmaket.com';
  const hasYearly = fee?.period === 'monthly' && typeof fee.amount_minor === 'number' && fee.amount_minor > 0;
  const monthlyMoney = fee && fee.amount_minor !== null ? formatMoney({ amount_minor: String(fee.amount_minor), currency: config.currency ?? 'VND' }, locale) : null;
  const yearlyMoney = fee && typeof fee.amount_minor === 'number' ? formatMoney({ amount_minor: String(fee.amount_minor * 12), currency: config.currency ?? 'VND' }, locale) : null;
  const feeMissing = !fee || fee.amount_minor === null;

  async function buy() {
    setBusy(true); setError(null);
    const res = await api<{ id: string }>('/quotes/domain-package', {
      method: 'POST',
      body: { site_id: siteId, ...(hasYearly ? { domain_interval: interval } : {}) },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/checkout/review?quote=${res.data.id}`);
  }

  return (
    <div className="stack">
      <h1>{t('ui.checkout.domain.title')}</h1>
      <p className="muted">{t('ui.checkout.domain.body')}</p>
      {error ? <ErrorState error={error} /> : null}
      <div className="card stack">
        <p style={{ margin: 0 }}><strong>{site.display_name}</strong></p>
        <p className="mono" style={{ margin: 0 }}>{site.subdomain}.{baseDomain}</p>
        <p className="muted" style={{ margin: 0 }}>
          {site.domain_paid_until
            ? (new Date(site.domain_paid_until).getFullYear() > 9000 ? t('ui.sites.domain_pkg_forever') : t('ui.sites.domain_pkg_until', { date: dt(site.domain_paid_until) }))
            : t('ui.sites.domain_pkg_never')}
        </p>
      </div>
      {feeMissing ? (
        <Alert tone="info"><p>{t('ui.checkout.domain.fee_unset')}</p></Alert>
      ) : hasYearly ? (
        <div className="card stack">
          <strong>{t('ui.checkout.domain_billing_label')}</strong>
          <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="domain-period" checked={interval === 'monthly'} onChange={() => setInterval('monthly')} />
            <span>{t('ui.checkout.billing_monthly')} · <span className="tabular">{monthlyMoney}</span></span>
          </label>
          <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="domain-period" checked={interval === 'yearly'} onChange={() => setInterval('yearly')} />
            <span>{t('ui.checkout.billing_yearly')} · <span className="tabular">{yearlyMoney}</span></span>
          </label>
        </div>
      ) : (
        <p className="muted">{t('ui.setup.subdomain_fee', { fee: monthlyMoney ?? '', period: fee?.period === 'monthly' ? t('ui.setup.fee_monthly') : t('ui.setup.fee_once') })}</p>
      )}
      <div className="row">
        <button type="button" className="button" disabled={busy || feeMissing} onClick={() => void buy()}>{busy ? t('ui.state.saving') : t('ui.checkout.continue')}</button>
        <Link href={`/account/sites/${siteId}`}>{t('ui.action.cancel')}</Link>
      </div>
    </div>
  );
}

export default function DomainPage() {
  return <AuthGate requireVerified>{() => <Suspense fallback={<Loading />}><DomainBuy /></Suspense>}</AuthGate>;
}
