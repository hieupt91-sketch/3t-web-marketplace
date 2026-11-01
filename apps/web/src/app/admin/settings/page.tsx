'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatMoney } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface PublicConfig {
  contact?: { phone: string | null; zalo: string | null; messenger: string | null; email: string | null };
  subdomain_fee?: { amount_minor: number | null; period: string } | null;
  installation_service?: { available: boolean; amount_minor: number | null };
  hosting_storage?: { per_gb_minor: number | null };
  payment?: { bank_transfer?: boolean; vnpay?: boolean; momo?: boolean; paypal?: boolean; usd_transfer?: boolean };
}
interface AdsSettings { enabled: boolean; left: { image_url: string }; right: { image_url: string } }

const METHOD_LABEL_KEYS: Record<string, string> = {
  bank_transfer: 'ui.checkout.method_bank',
  vnpay: 'ui.checkout.method_vnpay',
  momo: 'ui.checkout.method_momo',
  paypal: 'ui.checkout.method_paypal',
  usd_transfer: 'ui.checkout.method_usd',
};

/** Settings hub: every owner-facing setup area on one screen, each card
 *  showing its LIVE status so the owner sees what is on, what is off and
 *  what is still missing before diving into a form. */
function SettingsHubInner() {
  const { t, locale } = useT();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [ads, setAds] = useState<AdsSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void api<PublicConfig>('/config/public').then((res) => {
      if (res.ok) setCfg(res.data);
      else setError(res.error);
    });
    void api<AdsSettings>('/admin/settings/ads').then((res) => {
      if (res.ok) setAds(res.data);
    });
  }, []);

  if (error && !cfg) return <ErrorState error={error} />;
  if (!cfg) return <Loading />;

  const contact = cfg.contact ?? { phone: null, zalo: null, messenger: null, email: null };
  const contactCount = [contact.phone, contact.zalo, contact.messenger, contact.email].filter(Boolean).length;
  const fee = cfg.subdomain_fee;
  const svc = cfg.installation_service;
  const storage = cfg.hosting_storage;
  const pay = cfg.payment ?? {};
  const methods = Object.keys(METHOD_LABEL_KEYS);
  const onMethods = methods.filter((m) => pay[m as keyof typeof pay]);
  const adsSides = ads ? [ads.left.image_url, ads.right.image_url].filter(Boolean).length : 0;
  const adsOn = ads?.enabled === true && adsSides > 0;

  const pill = (on: boolean, label: string) => (
    <span className={`status-pill${on ? ' status-pill--on' : ''}`}>{label}</span>
  );

  return (
    <div className="stack">
      <h1>{t('ui.settings_hub.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.hint')}</p>
      <div className="grid-cards">
        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.contact_settings')}</h2>
            {pill(contactCount > 0, contactCount > 0 ? t('ui.settings_hub.channels_set', { count: String(contactCount) }) : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.contact_desc')}</p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/contact">{t('ui.settings_hub.open')}</Link></p>
        </section>

        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.payment_settings')}</h2>
            {pill(onMethods.length > 0, onMethods.length > 0 ? t('ui.settings_hub.methods_on', { count: String(onMethods.length), total: String(methods.length) }) : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {onMethods.length > 0 ? onMethods.map((m) => t(METHOD_LABEL_KEYS[m]!)).join(' · ') : t('ui.settings_hub.payments_desc')}
          </p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/payments">{t('ui.settings_hub.open')}</Link></p>
        </section>

        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.subdomain_fee_settings')}</h2>
            {pill(fee?.amount_minor != null, fee?.amount_minor != null ? formatMoney({ amount_minor: String(fee.amount_minor), currency: 'VND' }, locale) : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.fee_desc')}</p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/subdomain-fee">{t('ui.settings_hub.open')}</Link></p>
        </section>

        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.installation_service')}</h2>
            {pill(svc?.available === true, svc?.available === true && svc.amount_minor != null ? formatMoney({ amount_minor: String(svc.amount_minor), currency: 'VND' }, locale) : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.installation_desc')}</p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/installation-service">{t('ui.settings_hub.open')}</Link></p>
        </section>

        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.hosting_storage')}</h2>
            {pill(storage?.per_gb_minor != null, storage?.per_gb_minor != null ? `${formatMoney({ amount_minor: String(storage.per_gb_minor), currency: 'VND' }, locale)}/GB` : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.storage_desc')}</p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/hosting-storage">{t('ui.settings_hub.open')}</Link></p>
        </section>

        <section className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.admin.nav.ads_settings')}</h2>
            {pill(adsOn, adsOn ? t('ui.settings_hub.ads_on', { count: String(adsSides) }) : t('ui.settings_hub.not_set'))}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.settings_hub.ads_desc')}</p>
          <p style={{ margin: 0 }}><Link className="button button--secondary" href="/admin/settings/ads">{t('ui.settings_hub.open')}</Link></p>
        </section>
      </div>
    </div>
  );
}

export default function SettingsHubPage() {
  return (
    <RequirePermission permission="settings:manage">
      <SettingsHubInner />
    </RequirePermission>
  );
}
