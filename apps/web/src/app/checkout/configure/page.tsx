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
interface PublicConfig { site_base_domain?: string; currency?: string; subdomain_fee?: { amount_minor: number | null; period: string } | null }
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

  useEffect(() => {
    if (!slug) return;
    void api<Template>(`/templates/${encodeURIComponent(slug)}?locale=${locale}`).then((res) => {
      if (res.ok) {
        setTpl(res.data);
        setSelected(res.data.plans[0]?.id ?? '');
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
  const isHosted = plan?.deployment_mode === 'hosted';
  const name = subdomain.trim().toLowerCase();
  const nameReady = !isHosted || skipName || (hold?.kind === 'held_you' && heldName === name && name !== '');
  const baseDomain = config?.site_base_domain ?? 'webmaket.com';
  const fee = config?.subdomain_fee && config.subdomain_fee.amount_minor !== null
    ? formatMoney({ amount_minor: String(config.subdomain_fee.amount_minor), currency: config.currency ?? 'VND' }, locale)
    : null;

  async function continueToReview() {
    if (!tpl || !selected) return;
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { template_id: tpl.id, plan_id: selected };
    if (isHosted && !skipName) {
      body.site_request = { subdomain: name, display_name: displayName.trim() || tpl!.title, locale };
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
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field"><strong>{t('ui.checkout.choose_plan')}</strong></legend>
        {tpl.plans.map((p) => {
          const price = firstCharge(p);
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
                {fee ? <p className="muted" style={{ margin: 0 }}>{t('ui.setup.subdomain_fee', { fee, period: config?.subdomain_fee?.period === 'monthly' ? t('ui.setup.fee_monthly') : t('ui.setup.fee_once') })}</p> : null}
              </div>
            </>
          ) : null}
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
