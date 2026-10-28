'use client';

import { formatMoney, type Locale } from '@3t/i18n';
import { useT } from '@/lib/i18n';

export interface Price {
  interval: 'one_time' | 'monthly' | 'yearly';
  amount_minor: string;
  currency: string;
}

export interface Plan {
  id: string;
  code: string;
  deployment_mode: 'selfhost' | 'hosted';
  name: Record<string, string>;
  limits: Record<string, unknown>;
  prices: Price[];
}

/** PriceBreakdown (docs/05 §3): one-time vs recurring shown separately; hosting fees never hidden. */
export function PriceBreakdown({ plan, locale }: { plan: Plan; locale: Locale }) {
  const { t } = useT();
  const oneTime = plan.prices.find((p) => p.interval === 'one_time');
  const recurring = plan.prices.find((p) => p.interval === 'monthly' || p.interval === 'yearly');
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{plan.name[locale] ?? plan.name.vi ?? plan.code}</h3>
        <span className="badge badge--neutral">{t(`ui.deployment.${plan.deployment_mode}`)}</span>
      </div>
      <dl className="details">
        {oneTime ? (
          <>
            <dt>{plan.deployment_mode === 'hosted' ? t('ui.price.setup') : t('ui.price.one_time')}</dt>
            <dd className="tabular"><strong>{formatMoney(oneTime, locale)}</strong></dd>
          </>
        ) : null}
        {recurring ? (
          <>
            <dt>{t(`ui.price.${recurring.interval}`)}</dt>
            <dd className="tabular"><strong>{formatMoney(recurring, locale)}</strong> / {t(`ui.price.per_${recurring.interval}`)}</dd>
          </>
        ) : null}
        {typeof plan.limits.instance_limit === 'number' ? (
          <>
            <dt>{t('ui.plan.instances')}</dt>
            <dd className="tabular">{String(plan.limits.instance_limit)}</dd>
          </>
        ) : null}
        {typeof plan.limits.updates_months === 'number' ? (
          <>
            <dt>{t('ui.plan.updates')}</dt>
            <dd>{t('ui.plan.updates_months', { months: String(plan.limits.updates_months) })}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
