'use client';

import { useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, EmptyState, ErrorState, FormField, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Policy {
  id: string;
  code: string;
  rate_bps: number;
  reseller_discount_bps: number;
  hold_days: number;
  payout_min_minor: string;
  active: boolean;
}
interface CategoryDiscount {
  category_id: string;
  code: string;
  discount_bps: number | null;
}

function pctToBps(value: string): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}
const bpsToPct = (bps: number) => String(bps / 100);

/** Partner policies: the global wallet cut + referral commission per
 *  policy, and the per-category discount overrides (v32). Partner
 *  pricing is a % cut ONLY — global, or per category when set. */
function PoliciesInner() {
  const { t } = useT();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [categories, setCategories] = useState<CategoryDiscount[]>([]);
  const [cuts, setCuts] = useState<Record<string, string>>({});
  const [commissions, setCommissions] = useState<Record<string, string>>({});
  const [catInputs, setCatInputs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([api<Policy[]>('/admin/partner-policies'), api<CategoryDiscount[]>('/admin/partner-category-discounts')]);
    if (!p.ok) return setError(p.error);
    if (!c.ok) return setError(c.error);
    setPolicies(p.data);
    setCategories(c.data);
    setCuts(Object.fromEntries(p.data.map((x) => [x.id, bpsToPct(x.reseller_discount_bps)])));
    setCommissions(Object.fromEntries(p.data.map((x) => [x.id, bpsToPct(x.rate_bps)])));
    setCatInputs(Object.fromEntries(c.data.map((x) => [x.category_id, x.discount_bps === null ? '' : bpsToPct(x.discount_bps)])));
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function savePolicy(policy: Policy) {
    const cut = pctToBps(cuts[policy.id] ?? '');
    const commission = pctToBps(commissions[policy.id] ?? '');
    if (cut === null || commission === null || cut > 9000) return setInvalid(true);
    setInvalid(false);
    setSaved(false);
    setError(null);
    setBusy(true);
    const res = await api(`/admin/partner-policies/${policy.id}`, { method: 'POST', body: { reseller_discount_bps: cut, rate_bps: commission } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    await load();
  }

  async function saveCategories() {
    const items: { category_id: string; discount_bps: number | null }[] = [];
    for (const c of categories) {
      const raw = (catInputs[c.category_id] ?? '').trim();
      if (raw === '') { items.push({ category_id: c.category_id, discount_bps: null }); continue; }
      const bps = pctToBps(raw);
      if (bps === null || bps > 9000) return setInvalid(true);
      items.push({ category_id: c.category_id, discount_bps: bps });
    }
    setInvalid(false);
    setSaved(false);
    setError(null);
    setBusy(true);
    const res = await api('/admin/partner-category-discounts', { method: 'POST', body: { items } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    await load();
  }

  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>{t('ui.admin.policy.title')}</h1>
      {error ? <ErrorState error={error} /> : null}
      {invalid ? <Alert tone="error"><p>{t('ui.pricing.invalid_amount')}</p></Alert> : null}
      {saved ? <Alert tone="success"><p>{t('ui.partner.prices_saved')}</p></Alert> : null}
      {policies.length === 0 ? <EmptyState title={t('ui.admin.policy.title')} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.partner.channel')}</th>
                <th scope="col">{t('ui.admin.policy.global_cut')}</th>
                <th scope="col">{t('ui.admin.policy.commission')}</th>
                <th scope="col">{t('ui.admin.policy.hold_days')}</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td className="mono">{policy.code}</td>
                  <td>
                    <input className="input tabular" inputMode="decimal" style={{ maxWidth: 100 }} value={cuts[policy.id] ?? ''}
                      onChange={(e) => setCuts((prev) => ({ ...prev, [policy.id]: e.target.value }))} disabled={busy} aria-label={t('ui.admin.policy.global_cut')} /> %
                  </td>
                  <td>
                    <input className="input tabular" inputMode="decimal" style={{ maxWidth: 100 }} value={commissions[policy.id] ?? ''}
                      onChange={(e) => setCommissions((prev) => ({ ...prev, [policy.id]: e.target.value }))} disabled={busy} aria-label={t('ui.admin.policy.commission')} /> %
                  </td>
                  <td className="tabular">{policy.hold_days}</td>
                  <td><button type="button" className="button button--secondary" disabled={busy} onClick={() => void savePolicy(policy)}>{t('ui.action.save')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.admin.policy.category_title')}</h2>
        <p className="muted" style={{ margin: 0 }}>{t('ui.admin.policy.category_hint')}</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.pricing.col_category')}</th>
                <th scope="col">{t('ui.admin.policy.category_pct')}</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category_id}>
                  <td className="mono">{c.code}</td>
                  <td>
                    <input className="input tabular" inputMode="decimal" style={{ maxWidth: 120 }} value={catInputs[c.category_id] ?? ''}
                      onChange={(e) => setCatInputs((prev) => ({ ...prev, [c.category_id]: e.target.value }))} disabled={busy}
                      aria-label={c.code} /> %
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="button" className="button" disabled={busy} onClick={() => void saveCategories()}>{t('ui.action.save')}</button>
        </div>
      </section>
    </div>
  );
}

export default function AdminPartnerPolicies() {
  return (
    <RequirePermission permission="partner:read">
      <PoliciesInner />
    </RequirePermission>
  );
}
