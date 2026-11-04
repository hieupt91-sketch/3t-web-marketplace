'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { Alert, EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface OrderDetail {
  id: string;
  payment_status: string;
  total_minor: string;
  currency: string;
  terms_version: string;
  items: { template_id: string; deployment_mode: string; unit_price_minor: string }[];
  installation_status?: string | null;
  setup_info?: SetupInfoState | null;
  paid_at: string | null;
  created_at: string;
}
interface SetupInfoData {
  business_name: string;
  phone?: string; email?: string; address?: string; about?: string;
  logo_url?: string; facebook_url?: string; zalo?: string;
  google_sheet_url?: string; note?: string;
  seo_title?: string; seo_description?: string;
}
interface SetupInfoState { submitted: boolean; submitted_at: string | null; data: SetupInfoData | null }

const SETUP_FIELDS: { key: keyof SetupInfoData; label: string; kind: 'input' | 'textarea'; maxLength: number; type?: string; hint?: string }[] = [
  { key: 'business_name', label: 'ui.setup_info.field_business_name', kind: 'input', maxLength: 200 },
  { key: 'phone', label: 'ui.setup_info.field_phone', kind: 'input', maxLength: 32, type: 'tel' },
  { key: 'email', label: 'ui.setup_info.field_email', kind: 'input', maxLength: 254, type: 'email' },
  { key: 'address', label: 'ui.setup_info.field_address', kind: 'input', maxLength: 500 },
  { key: 'about', label: 'ui.setup_info.field_about', kind: 'textarea', maxLength: 5000 },
  { key: 'logo_url', label: 'ui.setup_info.field_logo_url', kind: 'input', maxLength: 1000, type: 'url' },
  { key: 'facebook_url', label: 'ui.setup_info.field_facebook_url', kind: 'input', maxLength: 1000, type: 'url' },
  { key: 'zalo', label: 'ui.setup_info.field_zalo', kind: 'input', maxLength: 100 },
  { key: 'google_sheet_url', label: 'ui.setup_info.field_google_sheet_url', kind: 'input', maxLength: 2000, type: 'url', hint: 'ui.setup_info.sheet_hint' },
  { key: 'note', label: 'ui.setup_info.field_note', kind: 'textarea', maxLength: 2000 },
  { key: 'seo_title', label: 'ui.setup_info.field_seo_title', kind: 'input', maxLength: 200, hint: 'ui.setup_info.seo_blank_hint' },
  { key: 'seo_description', label: 'ui.setup_info.field_seo_description', kind: 'textarea', maxLength: 500, hint: 'ui.setup_info.seo_blank_hint' },
];

function SetupInfoSummary({ data }: { data: SetupInfoData }) {
  const { t } = useT();
  return (
    <dl className="details">
      {SETUP_FIELDS.map((f) => {
        const v = data[f.key];
        return v ? (
          <div key={f.key} style={{ display: 'contents' }}>
            <dt>{t(f.label)}</dt>
            <dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}

/** One-time setup info for a static purchase (owner model 2026-11-03):
 *  the form stays on the order until the buyer submits — the right never
 *  expires — and the submission itself locks the information for good.
 *  Warnings repeat at every step: a banner when the form opens, then an
 *  explicit confirm step; only the confirm button calls the API. */
function SetupInfoCard({ orderId, info, onSubmitted }: { orderId: string; info: SetupInfoState; onSubmitted: () => void }) {
  const { t, dt } = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (info.submitted && info.data) {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('ui.setup_info.submitted_title')}</h2>
        <Alert tone="info"><p>{t('ui.setup_info.submitted_note')}</p></Alert>
        {info.submitted_at ? <p className="muted" style={{ margin: 0 }}>{t('ui.setup_info.submitted_at_label')}: {dt(info.submitted_at)}</p> : null}
        <SetupInfoSummary data={info.data} />
      </div>
    );
  }

  const entered: SetupInfoData = { business_name: (values.business_name ?? '').trim() };
  for (const f of SETUP_FIELDS) {
    if (f.key === 'business_name') continue;
    const v = (values[f.key] ?? '').trim();
    if (v) entered[f.key] = v;
  }

  async function confirmSubmit() {
    setBusy(true);
    setError(null);
    const res = await api(`/orders/${orderId}/setup-info`, { method: 'POST', body: entered });
    setBusy(false);
    if (!res.ok) {
      // Already locked (e.g. submitted in another tab): reload into the
      // locked summary instead of showing a dead-end error.
      if (res.error.code === 'setup_info.already_submitted') return onSubmitted();
      return setError(res.error);
    }
    onSubmitted();
  }

  if (stage === 'confirm') {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('ui.setup_info.title')}</h2>
        <Alert tone="warning" title={t('ui.setup_info.confirm_title')}><p>{t('ui.setup_info.confirm_body')}</p></Alert>
        <SetupInfoSummary data={entered} />
        {error ? <ErrorState error={error} /> : null}
        <div className="row">
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => setStage('edit')}>{t('ui.setup_info.confirm_back')}</button>
          <button type="button" className="button" disabled={busy} onClick={() => void confirmSubmit()}>{t('ui.setup_info.confirm_lock')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{t('ui.setup_info.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('ui.setup_info.intro')}</p>
      <Alert tone="warning" title={t('ui.setup_info.warn_title')}><p>{t('ui.setup_info.warn_body')}</p></Alert>
      {error ? <ErrorState error={error} /> : null}
      <form
        className="stack"
        onSubmit={(e) => { e.preventDefault(); setError(null); setStage('confirm'); }}
      >
        {SETUP_FIELDS.map((f) => (
          <label key={f.key} className="field">
            <span>{t(f.label)}{f.key === 'business_name' ? ' *' : ''}</span>
            {f.kind === 'textarea' ? (
              <textarea
                className="textarea" rows={f.key === 'about' ? 5 : 3} maxLength={f.maxLength}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                className="input" type={f.type ?? 'text'} maxLength={f.maxLength}
                required={f.key === 'business_name'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            )}
            {f.hint ? <span className="field__hint">{t(f.hint)}</span> : null}
          </label>
        ))}
        <div className="row">
          <button type="submit" className="button">{t('ui.setup_info.finish_button')}</button>
        </div>
      </form>
    </div>
  );
}
interface Attempt {
  id: string;
  provider: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: string;
}
interface Refund {
  id: string;
  amount_minor: string;
  currency: string;
  status: string;
  created_at: string;
}

/** C04 — buyer order detail: totals, items, attempts, refunds. No invoice claim when none exists. */
function OrderDetailInner() {
  const { t, dt, locale } = useT();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const [o, a, r] = await Promise.all([
      api<OrderDetail>(`/orders/${id}`),
      api<Attempt[]>(`/orders/${id}/payment-attempts`),
      api<Refund[]>(`/orders/${id}/refund-requests`),
    ]);
    if (!o.ok) return setError(o.error);
    setOrder(o.data);
    if (a.ok) setAttempts(a.data);
    if (r.ok) setRefunds(r.data);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error && !order) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!order) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.account.orders_title')}</h1>
      <div className="card stack">
        <dl className="details">
          <dt>{t('ui.checkout.order_id')}</dt><dd className="mono">{order.id}</dd>
          <dt>{t('ui.checkout.total')}</dt><dd className="tabular"><strong>{formatMoney({ amount_minor: order.total_minor, currency: order.currency }, locale)}</strong></dd>
          <dt>{t('ui.checkout.issue_attempts')}</dt><dd>{dt(order.created_at)}{order.paid_at ? ` → ${dt(order.paid_at)}` : ''}</dd>
        </dl>
        <StatusBadge tone={order.payment_status === 'paid' ? 'success' : 'neutral'}>{t(`ui.order.status.${order.payment_status}`)}</StatusBadge>
        <div className="row">
          <Link className="button button--secondary" href={`/checkout/orders/${id}/issue`}>{t('ui.checkout.issue_title')}</Link>
          {order.payment_status === 'awaiting_payment' ? <Link className="button" href={`/checkout/orders/${id}/pay`}>{t('ui.checkout.issue_pay_again')}</Link> : null}
        </div>
      </div>
      <h2>{t('ui.account.order_items')}</h2>
      {order.items.length === 0 ? <EmptyState title={t('ui.account.order_items')}><p>—</p></EmptyState> : (
        <ul>{order.items.map((item, i) => (
          <li key={i} className="tabular">{item.deployment_mode} — {formatMoney({ amount_minor: item.unit_price_minor, currency: order.currency }, locale)}</li>
        ))}</ul>
      )}
      {order.setup_info ? <SetupInfoCard orderId={order.id} info={order.setup_info} onSubmitted={() => void load()} /> : null}
      <h2>{t('ui.checkout.issue_attempts')}</h2>
      <ul>{attempts.map((a) => <li key={a.id}>{a.provider} · {formatMoney({ amount_minor: a.amount_minor, currency: a.currency }, locale)} · {a.status} · {dt(a.created_at)}</li>)}</ul>
      <h2>{t('ui.account.refund_requests')}</h2>
      <ul>{refunds.map((r) => <li key={r.id}>{formatMoney({ amount_minor: r.amount_minor, currency: r.currency }, locale)} · {t(`ui.refund.status.${r.status}`)} · {dt(r.created_at)}</li>)}</ul>
    </div>
  );
}

export default function OrderDetailPage() {
  return <OrderDetailInner />;
}
