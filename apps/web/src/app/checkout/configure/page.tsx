'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { isDynamicAdapter } from '@/lib/template-kind';

interface Plan { id: string; code: string; deployment_mode: string; name: Record<string, string>; prices: { interval: string; amount_minor: string; currency: string }[] }
interface Template { id: string; slug: string; title: string; adapter: string | null; plans: Plan[] }
interface PublicConfig { site_base_domain?: string; currency?: string; subdomain_fee?: { amount_minor: number | null; period: string } | null; installation_service?: { available: boolean; amount_minor: number | null }; hosting_storage?: { per_gb_minor: number | null } }
interface SubCheck { available: boolean; reason: string | null; held_by_you?: boolean; reservation_expires_at?: string }

type HoldState =
  | { kind: 'held_you'; expiresAt: string }
  | { kind: 'held_other' }
  | { kind: 'taken' }
  | { kind: 'invalid' }
  | { kind: 'reserved' };

function Configure() {
  const { t, dt, locale } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const slug = params.get('template') ?? '';
  const upgrade = params.get('upgrade') ?? '';
  const [tpl, setTpl] = useState<Template | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Hosted purchases choose their domain right here (owner rule
  // 2026-11-01): name + site title ride along with the quote, and the
  // site is created automatically once the order is paid.
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [subdomain, setSubdomain] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [skipName, setSkipName] = useState(false);
  const [hold, setHold] = useState<HoldState | null>(null);
  const [heldName, setHeldName] = useState('');
  const [holdBusy, setHoldBusy] = useState(false);
  // Split packages: hosting period, domain period and the separate
  // installation service are the buyer's own choices (owner prices only).
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [domainInterval, setDomainInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [installation, setInstallation] = useState(false);
  const [storageGb, setStorageGb] = useState(1);

  useEffect(() => {
    if (!slug) return;
    void api<Template>(`/templates/${encodeURIComponent(slug)}?locale=${locale}`).then((res) => {
      if (res.ok) {
        setTpl(res.data);
        const upgradePlan = upgrade ? res.data.plans.find((pl) => pl.deployment_mode === 'hosted') : undefined;
        setSelected(upgradePlan?.id ?? res.data.plans[0]?.id ?? '');
        setDisplayName((prev) => prev || res.data.title);
      } else setError(res.error);
    });
    void api<PublicConfig>('/config/public').then((res) => { if (res.ok) setConfig(res.data); });
  }, [slug, locale]);

  async function checkHold() {
    const name = subdomain.trim().toLowerCase();
    if (!name) return;
    setHoldBusy(true);
    setError(null);
    const check = await api<SubCheck>(`/sites/check-subdomain?subdomain=${encodeURIComponent(name)}`);
    if (!check.ok) {
      setHoldBusy(false);
      setError(check.error);
      return;
    }
    if (!check.data.available) {
      setHoldBusy(false);
      setHold(
        check.data.reason === 'taken' ? { kind: 'taken' }
          : check.data.reason === 'reserved' ? { kind: 'reserved' }
            : check.data.reason === 'held' ? { kind: 'held_other' }
              : { kind: 'invalid' },
      );
      return;
    }
    if (check.data.held_by_you && check.data.reservation_expires_at) {
      setHoldBusy(false);
      setHeldName(name);
      setHold({ kind: 'held_you', expiresAt: check.data.reservation_expires_at });
      return;
    }
    if (heldName && heldName !== name) {
      await api(`/sites/subdomain-reservations/${encodeURIComponent(heldName)}`, { method: 'DELETE' });
      setHeldName('');
    }
    const res = await api<{ subdomain: string; expires_at: string }>('/sites/subdomain-reservations', {
      method: 'POST',
      body: { subdomain: name },
    });
    setHoldBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setHeldName(name);
    setHold({ kind: 'held_you', expiresAt: res.data.expires_at });
  }

  if (!slug) return <p className="muted">{t('ui.checkout.no_template')}</p>;
  if (error && !tpl) return <ErrorState error={error} />;
  if (!tpl) return <Loading />;
  if (tpl.plans.length === 0) return <Alert tone="info"><p>{t('ui.detail.no_plans')}</p></Alert>;

  const firstCharge = (p: Plan) => p.prices.find((x) => x.interval === 'one_time') ?? p.prices[0];
  const plan = tpl.plans.find((p) => p.id === selected) ?? null;
  const monthlyPrice = plan?.prices.find((x) => x.interval === 'monthly');
  const yearlyPrice = plan?.prices.find((x) => x.interval === 'yearly');
  const hasBothPeriods = Boolean(monthlyPrice && yearlyPrice);
  const chosenRecurring = billingInterval === 'yearly' && yearlyPrice ? yearlyPrice : (monthlyPrice ?? yearlyPrice);
  const feeSetting = config?.subdomain_fee ?? null;
  const currency = config?.currency ?? 'VND';
  const feeMonthly = feeSetting && feeSetting.amount_minor !== null
    ? formatMoney({ amount_minor: String(feeSetting.amount_minor), currency }, locale)
    : null;
  const feeYearly = feeSetting && typeof feeSetting.amount_minor === 'number'
    ? formatMoney({ amount_minor: String(feeSetting.amount_minor * 12), currency }, locale)
    : null;
  const feeHasYearly = feeSetting?.period === 'monthly' && feeYearly !== null;
  const fee = feeHasYearly && domainInterval === 'yearly' ? feeYearly : feeMonthly;
  const svc = config?.installation_service;
  const svcPrice = svc?.available && svc.amount_minor !== null && svc.amount_minor !== undefined
    ? formatMoney({ amount_minor: String(svc.amount_minor), currency }, locale)
    : null;
  // Storage-priced hosting (v33): ONE owner rate per GB per month. The
  // buyer picks GB and a period in a single block; the total multiplies
  // automatically (yearly = 12 months). The period choice always exists
  // in this mode, whatever flat prices the plan carries.
  const storageRate = config?.hosting_storage?.per_gb_minor;
  const storageActive = Boolean(plan?.deployment_mode === 'hosted' && typeof storageRate === 'number' && storageRate > 0);
  const effectivePeriod = storageActive ? billingInterval : hasBothPeriods ? billingInterval : (monthlyPrice ? 'monthly' : 'yearly');
  const storageMonths = effectivePeriod === 'yearly' ? 12 : 1;
  const storageTotal = storageActive ? formatMoney({ amount_minor: String((storageRate as number) * storageGb * storageMonths), currency }, locale) : null;
  const storageMonthlyTotal = storageActive ? formatMoney({ amount_minor: String((storageRate as number) * storageGb), currency }, locale) : null;
  const storageYearlyTotal = storageActive ? formatMoney({ amount_minor: String((storageRate as number) * storageGb * 12), currency }, locale) : null;
  const storageRateMoney = storageActive ? formatMoney({ amount_minor: String(storageRate as number), currency }, locale) : null;
  const isHosted = plan?.deployment_mode === 'hosted';
  const name = subdomain.trim().toLowerCase();
  const nameReady = !isHosted || skipName || (hold?.kind === 'held_you' && heldName === name && name !== '');
  const baseDomain = config?.site_base_domain ?? 'webmaket.com';

  async function continueToReview() {
    if (!tpl || !selected) return;
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { template_id: tpl.id, plan_id: selected };
    if (isHosted && (hasBothPeriods || storageActive)) body.billing_interval = billingInterval;
    if (isHosted) body.storage_gb = storageGb;
    if (isHosted && upgrade) body.upgrade_entitlement_id = upgrade;
    if (installation && svcPrice) body.installation = true;
    if (isHosted && !skipName) {
      body.site_request = { subdomain: name, display_name: displayName.trim() || tpl!.title, locale, ...(feeHasYearly ? { domain_interval: domainInterval } : {}) };
    }
    const res = await api<{ id: string }>('/quotes', { method: 'POST', body });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === 'site.subdomain_held') setHold({ kind: 'held_other' });
      if (res.error.code === 'site.subdomain_taken') setHold({ kind: 'taken' });
      return setError(res.error);
    }
    router.push(`/checkout/review?quote=${res.data.id}`);
  }

  return (
    <div className="stack">
      <h1>{t('ui.checkout.configure_title')}</h1>
      <p className="muted">
        {tpl.title}{' '}
        {isDynamicAdapter(tpl.adapter) ? (
          <span className="badge badge--info">{t('ui.catalog.badge_dynamic')}</span>
        ) : (
          <span className="badge badge--neutral">{t('ui.catalog.kind_static')}</span>
        )}
      </p>
      {error ? <ErrorState error={error} /> : null}
      {upgrade ? <Alert tone="info"><p>{t('ui.checkout.upgrade_note')}</p></Alert> : null}
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field"><strong>{t('ui.checkout.choose_plan')}</strong></legend>
        {tpl.plans.map((p) => {
          const price = p.deployment_mode === 'hosted' && p.id === selected && storageActive
            ? { interval: effectivePeriod, amount_minor: String((storageRate as number) * storageGb * storageMonths), currency: p.prices[0]?.currency ?? 'VND' }
            : p.deployment_mode === 'hosted' && p.id === selected && chosenRecurring ? chosenRecurring : firstCharge(p);
          return (
            <label key={p.id} className="card row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
              <span className="row">
                <input type="radio" name="plan" value={p.id} checked={selected === p.id} onChange={() => setSelected(p.id)} />
                <span><strong>{p.name[locale] ?? p.name.vi ?? p.code}</strong> · {t(`ui.deployment.${p.deployment_mode}`)}</span>
              </span>
              <span className="tabular">{price ? formatMoney(price, locale) : '—'}</span>
            </label>
          );
        })}
      </fieldset>
      {isHosted && hasBothPeriods && !storageActive ? (
        <div className="card stack">
          <strong>{t('ui.checkout.billing_label')}</strong>
          <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="billing" checked={billingInterval === 'monthly'} onChange={() => setBillingInterval('monthly')} />
            <span>{t('ui.checkout.billing_monthly')} · <span className="tabular">{monthlyPrice ? formatMoney(monthlyPrice, locale) : ''}</span></span>
          </label>
          <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="billing" checked={billingInterval === 'yearly'} onChange={() => setBillingInterval('yearly')} />
            <span>{t('ui.checkout.billing_yearly')} · <span className="tabular">{yearlyPrice ? formatMoney(yearlyPrice, locale) : ''}</span></span>
          </label>
        </div>
      ) : null}
      {storageActive ? (
        <div className="card stack">
          <strong>{t('ui.checkout.storage_label')}</strong>
          <div className="row" style={{ alignItems: 'center' }}>
            {[1, 2, 5, 10].map((gb) => (
              <button key={gb} type="button" className={storageGb === gb ? 'button' : 'button button--secondary'} onClick={() => setStorageGb(gb)}>{gb} GB</button>
            ))}
            <input
              className="input" type="number" min={1} max={100} value={storageGb} style={{ width: 90 }}
              onChange={(e) => setStorageGb(Math.max(1, Math.min(100, Math.trunc(Number(e.target.value) || 1))))}
              aria-label={t('ui.checkout.storage_label')}
            />
            <span className="muted">GB</span>
          </div>
          <div className="stack">
            <strong>{t('ui.checkout.billing_label')}</strong>
            <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
              <input type="radio" name="billing" checked={billingInterval === 'monthly'} onChange={() => setBillingInterval('monthly')} />
              <span>{t('ui.checkout.billing_monthly')} · <span className="tabular">{storageMonthlyTotal}</span></span>
            </label>
            <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
              <input type="radio" name="billing" checked={billingInterval === 'yearly'} onChange={() => setBillingInterval('yearly')} />
              <span>{t('ui.checkout.billing_yearly')} · <span className="tabular">{storageYearlyTotal}</span></span>
            </label>
          </div>
          <p className="muted" style={{ margin: 0 }}>{t(storageMonths === 12 ? 'ui.checkout.storage_total_yearly' : 'ui.checkout.storage_total', { gb: String(storageGb), rate: storageRateMoney ?? '', total: storageTotal ?? '' })}</p>
        </div>
      ) : null}
      {(() => {
        if (!plan || plan.deployment_mode !== 'selfhost') return null;
        const runtime = tpl.adapter === 'node-http' || tpl.adapter === 'next-standalone';
        return <Alert tone="info"><p>{runtime ? t('ui.detail.hosting_runtime') : t('ui.detail.hosting_static')}</p></Alert>;
      })()}
      {isHosted ? (
        <div className="card stack">
          <strong>{t('ui.checkout.site_domain_label')}</strong>
          <label className="row" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={skipName} onChange={(e) => setSkipName(e.target.checked)} />
            <span>{t('ui.checkout.site_skip')}</span>
          </label>
          {!skipName ? (
            <>
              <label className="field">
                <span>{t('ui.checkout.site_name_label')}</span>
                <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
              </label>
              <label className="field">
                <span>{t('ui.checkout.site_domain_label')}</span>
                <span className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
                  <input
                    className="input mono"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                    value={subdomain}
                    onChange={(e) => { setSubdomain(e.target.value.toLowerCase()); setHold(null); }}
                    pattern="[a-z0-9][a-z0-9-]{2,39}"
                    placeholder="ten-cua-ban"
                  />
                  <span className="muted">.{baseDomain}</span>
                </span>
                <span className="field__hint">{t('ui.sites.subdomain_hint')}</span>
              </label>
              <div className="stack">
                <div className="row">
                  <button type="button" className="button button--secondary" disabled={holdBusy || !name} onClick={() => void checkHold()}>{t('ui.sites.subdomain_check_hold')}</button>
                </div>
                {hold ? (
                  <p style={{ margin: 0 }} role="status">
                    {hold.kind === 'held_you'
                      ? t('ui.sites.subdomain_held_you', { time: dt(hold.expiresAt) })
                      : hold.kind === 'held_other'
                        ? t('ui.sites.subdomain_held_other')
                        : hold.kind === 'taken'
                          ? t('ui.sites.subdomain_taken')
                          : hold.kind === 'reserved'
                            ? t('ui.setup.subdomain_reserved')
                            : t('ui.sites.subdomain_invalid')}
                  </p>
                ) : null}
                {feeHasYearly ? (
                  <div className="stack">
                    <strong>{t('ui.checkout.domain_billing_label')}</strong>
                    <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
                      <input type="radio" name="domain-billing" checked={domainInterval === 'monthly'} onChange={() => setDomainInterval('monthly')} />
                      <span>{t('ui.checkout.billing_monthly')} · <span className="tabular">{feeMonthly}</span></span>
                    </label>
                    <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
                      <input type="radio" name="domain-billing" checked={domainInterval === 'yearly'} onChange={() => setDomainInterval('yearly')} />
                      <span>{t('ui.checkout.billing_yearly')} · <span className="tabular">{feeYearly}</span></span>
                    </label>
                  </div>
                ) : fee ? <p className="muted" style={{ margin: 0 }}>{t('ui.setup.subdomain_fee', { fee, period: feeSetting?.period === 'monthly' ? t('ui.setup.fee_monthly') : t('ui.setup.fee_once') })}</p> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {svcPrice ? (
        <div className="card stack">
          <label className="row" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={installation} onChange={(e) => setInstallation(e.target.checked)} />
            <span><strong>{t('ui.checkout.installation_title')}</strong> · <span className="tabular">{svcPrice}</span></span>
          </label>
          <p className="muted" style={{ margin: 0 }}>{t('ui.checkout.installation_body')}</p>
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="button" disabled={busy || !selected || !nameReady} onClick={() => void continueToReview()}>{busy ? t('ui.state.saving') : t('ui.checkout.continue')}</button>
        <Link href={`/${locale}/templates/${tpl.slug}`}>{t('ui.action.cancel')}</Link>
      </div>
    </div>
  );
}

export default function ConfigurePage() {
  return <AuthGate requireVerified>{() => <Suspense fallback={<Loading />}><Configure /></Suspense>}</AuthGate>;
}
