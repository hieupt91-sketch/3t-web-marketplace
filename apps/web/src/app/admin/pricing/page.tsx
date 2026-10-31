'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { Alert, EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { templateTone } from '@/lib/status';
import { isDynamicAdapter } from '@/lib/template-kind';

interface OverviewRow {
  id: string;
  slug: string;
  title_vi: string | null;
  adapter: string | null;
  category_id: string | null;
  category_code: string | null;
  status: string;
  hidden: boolean;
  current_price_minor: string | null;
}
interface Category {
  id: string;
  code: string;
  parent_id: string | null;
}
interface BulkResult {
  updated_count: number;
  failure_count: number;
}
type ScopeType = 'all' | 'category' | 'selected';
type ScopePayload = { type: 'all' } | { type: 'category'; category_id: string } | { type: 'ids'; template_ids: string[] };

function validAmount(value: string): boolean {
  return /^\d+$/.test(value) && BigInt(value) > 0n;
}

/** Quick pricing & visibility manager: per-row price + show/hide, plus bulk
 *  apply for all templates, one category, or the checked selection. Prices are
 *  the VND one_time price of each template's standard selfhost plan — the same
 *  "starting price" the catalog shows. */
function PricingInner() {
  const { t, locale } = useT();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [kindFilter, setKindFilter] = useState<'' | 'static' | 'dynamic'>('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<ScopeType>('all');
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkAmount, setBulkAmount] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failures: number } | null>(null);

  const load = useCallback(async () => {
    const res = await api<OverviewRow[]>('/admin/templates/pricing-overview');
    if (!res.ok) return setError(res.error);
    setRows(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    void api<Category[]>('/admin/categories').then((res) => {
      if (res.ok) setCategories(res.data);
    });
  }, [load]);

  const selectedIds = rows.filter((r) => selected[r.id]).map((r) => r.id);

  function scopePayload(): ScopePayload | null {
    if (scope === 'all') return { type: 'all' };
    if (scope === 'category') return bulkCategory ? { type: 'category', category_id: bulkCategory } : null;
    return selectedIds.length > 0 ? { type: 'ids', template_ids: selectedIds } : null;
  }

  async function saveRowPrice(row: OverviewRow) {
    const value = (inputs[row.id] ?? '').replace(/\D/g, '');
    if (!validAmount(value)) return setInvalid(true);
    setInvalid(false);
    setNotice(null);
    setError(null);
    setRowBusy(row.id);
    const res = await api(`/admin/templates/${row.id}/quick-price`, { method: 'PUT', body: { amount_minor: value } });
    setRowBusy(null);
    if (!res.ok) return setError(res.error);
    setNotice({ text: t('ui.pricing.saved_price'), failures: 0 });
    await load();
  }

  async function toggleVisibility(row: OverviewRow) {
    setNotice(null);
    setError(null);
    setRowBusy(row.id);
    const res = await api(`/admin/templates/${row.id}/visibility`, { method: 'POST', body: { hidden: !row.hidden } });
    setRowBusy(null);
    if (!res.ok) return setError(res.error);
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, hidden: !row.hidden } : r)));
  }

  async function applyBulkPrice() {
    const payload = scopePayload();
    if (!payload) return;
    const value = bulkAmount.replace(/\D/g, '');
    if (!validAmount(value)) return setInvalid(true);
    setInvalid(false);
    if (payload.type === 'all') {
      const amount = formatMoney({ amount_minor: value, currency: 'VND' }, locale);
      if (!window.confirm(t('ui.pricing.confirm_all_price', { amount, count: rows.length }))) return;
    }
    setNotice(null);
    setError(null);
    setBulkBusy(true);
    const res = await api<BulkResult>('/admin/templates/bulk-price', { method: 'POST', body: { amount_minor: value, scope: payload } });
    setBulkBusy(false);
    if (!res.ok) return setError(res.error);
    setNotice({ text: t('ui.pricing.result_price', { count: res.data.updated_count }), failures: res.data.failure_count });
    await load();
  }

  async function applyBulkVisibility(hidden: boolean) {
    const payload = scopePayload();
    if (!payload) return;
    if (payload.type === 'all') {
      const message = hidden
        ? t('ui.pricing.confirm_all_hide', { count: rows.length })
        : t('ui.pricing.confirm_all_show', { count: rows.length });
      if (!window.confirm(message)) return;
    }
    setNotice(null);
    setError(null);
    setBulkBusy(true);
    const res = await api<BulkResult>('/admin/templates/bulk-visibility', { method: 'POST', body: { hidden, scope: payload } });
    setBulkBusy(false);
    if (!res.ok) return setError(res.error);
    setNotice({ text: t('ui.pricing.result_visibility', { count: res.data.updated_count }), failures: res.data.failure_count });
    await load();
  }

  const payloadReady = scopePayload() !== null;
  // Display filter only: bulk scopes stay server-side (all / category /
  // selected ids); the kind filter just narrows which rows are on screen.
  const visibleRows = kindFilter === '' ? rows : rows.filter((r) => isDynamicAdapter(r.adapter) === (kindFilter === 'dynamic'));

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>{t('ui.pricing.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.pricing.hint')}</p>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {invalid ? <Alert tone="error"><p>{t('ui.pricing.invalid_amount')}</p></Alert> : null}
      {notice ? <Alert tone="success"><p>{notice.text}</p></Alert> : null}
      {notice && notice.failures > 0 ? <Alert tone="error"><p>{t('ui.pricing.result_failures', { count: notice.failures })}</p></Alert> : null}
      {!loaded && !error ? <Loading /> : null}
      {loaded && rows.length === 0 ? <EmptyState title={t('ui.pricing.empty')} /> : null}
      {rows.length > 0 ? (
        <>
          <section className="card stack">
            <h2 style={{ marginTop: 0 }}>{t('ui.pricing.bulk_title')}</h2>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field">
                <span>{t('ui.pricing.scope')}</span>
                <select className="select" value={scope} onChange={(e) => setScope(e.target.value as ScopeType)} disabled={bulkBusy}>
                  <option value="all">{t('ui.pricing.scope_all')}</option>
                  <option value="category">{t('ui.pricing.scope_category')}</option>
                  <option value="selected">{t('ui.pricing.scope_selected')}</option>
                </select>
              </label>
              {scope === 'category' ? (
                <label className="field">
                  <span>{t('ui.pricing.col_category')}</span>
                  <select className="select" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} disabled={bulkBusy}>
                    <option value="">{t('ui.pricing.select_category')}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.code}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {scope === 'selected' ? <span className="muted">{t('ui.pricing.selected_count', { count: selectedIds.length })}</span> : null}
              <label className="field">
                <span>{t('ui.pricing.bulk_price_label')}</span>
                <input
                  className="input tabular"
                  inputMode="numeric"
                  value={bulkAmount}
                  onChange={(e) => setBulkAmount(e.target.value.replace(/\D/g, ''))}
                  disabled={bulkBusy}
                  autoComplete="off"
                />
              </label>
              <button type="button" className="button" disabled={bulkBusy || !payloadReady} onClick={() => void applyBulkPrice()}>
                {t('ui.pricing.apply_price')}
              </button>
              <button type="button" className="button button--secondary" disabled={bulkBusy || !payloadReady} onClick={() => void applyBulkVisibility(true)}>
                {t('ui.pricing.hide')}
              </button>
              <button type="button" className="button button--secondary" disabled={bulkBusy || !payloadReady} onClick={() => void applyBulkVisibility(false)}>
                {t('ui.pricing.show')}
              </button>
            </div>
          </section>
          <div className="row" role="group" aria-label={t('ui.catalog.filter_kind')}>
            {(['', 'static', 'dynamic'] as const).map((k) => (
              <button key={k || 'all'} type="button" className={`button${kindFilter === k ? '' : ' button--secondary'}`} aria-pressed={kindFilter === k} onClick={() => setKindFilter(k)}>
                {k === '' ? t('ui.catalog.filter_all') : t(`ui.catalog.kind_${k}`)}
              </button>
            ))}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col"><span className="visually-hidden">{t('ui.pricing.scope_selected')}</span></th>
                  <th scope="col">{t('ui.admin.templates.col_name')}</th>
                  <th scope="col">{t('ui.admin.templates.col_kind')}</th>
                  <th scope="col">{t('ui.pricing.col_category')}</th>
                  <th scope="col">{t('ui.admin.templates.col_status')}</th>
                  <th scope="col">{t('ui.pricing.col_price')}</th>
                  <th scope="col">{t('ui.pricing.col_new_price')}</th>
                  <th scope="col">{t('ui.pricing.col_visibility')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!selected[row.id]}
                        onChange={(e) => setSelected((prev) => ({ ...prev, [row.id]: e.target.checked }))}
                        aria-label={row.slug}
                      />
                    </td>
                    <td>
                      <Link href={`/admin/templates/${row.id}`}><strong>{row.title_vi ?? row.slug}</strong></Link>
                      <div className="mono muted">{row.slug}</div>
                    </td>
                    <td>
                      <StatusBadge tone={isDynamicAdapter(row.adapter) ? 'info' : 'neutral'}>
                        {isDynamicAdapter(row.adapter) ? t('ui.catalog.kind_dynamic') : t('ui.catalog.kind_static')}
                      </StatusBadge>
                    </td>
                    <td>{row.category_code ?? '—'}</td>
                    <td>
                      <StatusBadge tone={templateTone(row.status)}>{t(`ui.template.status.${row.status}`)}</StatusBadge>
                      {row.hidden ? <> <StatusBadge tone="warning">{t('ui.pricing.hidden_state')}</StatusBadge></> : null}
                    </td>
                    <td className="tabular">
                      {row.current_price_minor
                        ? formatMoney({ amount_minor: row.current_price_minor, currency: 'VND' }, locale)
                        : <span className="muted">{t('ui.admin.templates.price_unset')}</span>}
                    </td>
                    <td>
                      <div className="row">
                        <input
                          className="input tabular"
                          inputMode="numeric"
                          style={{ maxWidth: 140 }}
                          value={inputs[row.id] ?? ''}
                          onChange={(e) => setInputs((prev) => ({ ...prev, [row.id]: e.target.value.replace(/\D/g, '') }))}
                          disabled={rowBusy === row.id}
                          autoComplete="off"
                          aria-label={t('ui.pricing.col_new_price')}
                        />
                        <button type="button" className="button button--secondary" disabled={rowBusy === row.id || !(inputs[row.id] ?? '')} onClick={() => void saveRowPrice(row)}>
                          {t('ui.pricing.set_price')}
                        </button>
                      </div>
                    </td>
                    <td>
                      <label className="row">
                        <input
                          type="checkbox"
                          checked={!row.hidden}
                          onChange={() => void toggleVisibility(row)}
                          disabled={rowBusy === row.id}
                          aria-label={t('ui.pricing.col_visibility')}
                        />
                        <span>{row.hidden ? t('ui.pricing.hidden_state') : t('ui.pricing.visible')}</span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function PricingPage() {
  return (
    <RequirePermission permission="pricing:write">
      <PricingInner />
    </RequirePermission>
  );
}
