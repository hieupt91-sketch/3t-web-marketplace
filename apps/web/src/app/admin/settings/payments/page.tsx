'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface MethodDef {
  slug: string;
  endpoint: string;
  nameKey: string;
  hintKey: string;
}

/** Payments settings INDEX: one card per method, each linking to that
 *  method's OWN settings page. No method's form is mixed into another's —
 *  PayPal settings live only on the PayPal page, and so on. */
const METHODS: MethodDef[] = [
  { slug: 'bank', endpoint: '/admin/settings/payment', nameKey: 'ui.checkout.method_bank', hintKey: 'ui.payment_settings.hint' },
  { slug: 'vnpay', endpoint: '/admin/settings/payment-vnpay', nameKey: 'ui.checkout.method_vnpay', hintKey: 'ui.payment_settings.vnpay_hint' },
  { slug: 'momo', endpoint: '/admin/settings/payment-momo', nameKey: 'ui.checkout.method_momo', hintKey: 'ui.payment_settings.momo_hint' },
  { slug: 'paypal', endpoint: '/admin/settings/payment-paypal', nameKey: 'ui.checkout.method_paypal', hintKey: 'ui.payment_settings.paypal_hint' },
  { slug: 'usd', endpoint: '/admin/settings/payment-usd', nameKey: 'ui.checkout.method_usd', hintKey: 'ui.payment_settings.usd_hint' },
];

function PaymentsIndex() {
  const { t } = useT();
  const [states, setStates] = useState<Record<string, boolean | null>>({});

  useEffect(() => {
    void (async () => {
      const results = await Promise.all(
        METHODS.map(async (m) => {
          const res = await api<{ enabled: boolean }>(m.endpoint);
          return [m.slug, res.ok ? res.data.enabled : null] as const;
        }),
      );
      setStates(Object.fromEntries(results));
    })();
  }, []);

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>{t('ui.payment_settings.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.payment_settings.index_hint')}</p>
      {METHODS.map((m) => (
        <section key={m.slug} className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t(m.nameKey)}</h2>
            {states[m.slug] !== undefined && states[m.slug] !== null ? (
              <span className={`status-pill${states[m.slug] ? ' status-pill--on' : ''}`}>
                {states[m.slug] ? t('ui.payment_settings.status_on') : t('ui.payment_settings.status_off')}
              </span>
            ) : null}
          </div>
          <p className="muted" style={{ margin: 0 }}>{t(m.hintKey)}</p>
          <p style={{ margin: 0 }}>
            <Link className="button button--secondary" href={`/admin/settings/payments/${m.slug}`}>
              {t('ui.settings_hub.open')}
            </Link>
          </p>
        </section>
      ))}
    </div>
  );
}

export default function PaymentSettingsIndexPage() {
  return (
    <RequirePermission permission="settings:manage">
      <PaymentsIndex />
    </RequirePermission>
  );
}
