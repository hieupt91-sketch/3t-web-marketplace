'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface PlanRow { template_slug: string; plan_id: string; plan_name: Record<string, string>; deployment_mode: string; listed_minor: string; cost_minor: string; partner_price_minor: string | null }
interface PricesData { reseller_discount_bps: number; plans: PlanRow[] }

const money = (amount: string, locale: 'vi' | 'en') => formatMoney({ amount_minor: amount, currency: 'VND' }, locale);

export default function PartnerPricesPage() {
  const { t, locale } = useT();
  const [data, setData] = useState<PricesData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<PricesData>('/partner/prices');
    if (!res.ok) return setError(res.error);
    setData(res.data);
    setDrafts(Object.fromEntries(res.data.plans.map((p) => [p.plan_id, p.partner_price_minor ?? ''])));
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <Loading />;

  async function save(planId: string) {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    const raw = (drafts[planId] ?? '').trim();
    const res = await api('/partner/prices', { method: 'PUT', body: { plan_id: planId, amount_minor: raw === '' ? null : raw } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    void load();
  }

  return (
    <div className="stack">
      <h1>{t('ui.partner.prices')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.partner.prices_hint', { pct: String(data.reseller_discount_bps / 100) })}</p>
      {saved ? <Alert tone="success"><p>{t('ui.partner.prices_saved')}</p></Alert> : null}
      {error ? <ErrorState error={error} /> : null}
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('ui.partner.price_template')}</th><th>{t('ui.partner.price_listed')}</th><th>{t('ui.partner.price_cost')}</th><th>{t('ui.partner.price_mine')}</th><th></th></tr></thead>
        <tbody>
          {data.plans.map((p) => (
            <tr key={p.plan_id}>
              <td>{p.template_slug} · {p.plan_name[locale] ?? p.plan_name.vi}</td>
              <td>{money(p.listed_minor, locale)}</td>
              <td>{money(p.cost_minor, locale)}</td>
              <td>
                <input
                  className="input" type="number" min={0} style={{ width: 150 }} value={drafts[p.plan_id] ?? ''}
                  placeholder={p.listed_minor}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.plan_id]: e.target.value }))}
                  aria-label={t('ui.partner.price_mine')}
                />
              </td>
              <td><button type="button" className="button button--secondary" disabled={busy} onClick={() => void save(p.plan_id)}>{t('ui.action.save')}</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
