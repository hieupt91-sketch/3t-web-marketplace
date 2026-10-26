'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney, type Locale } from '@3t/i18n';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { LocaleTabs, type LocaleStatus } from '@/components/locale-tabs';
import { Alert, ErrorState, FormField, Loading, StatusBadge, fieldErrorFor, useFieldError } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { templateTone } from '@/lib/status';

interface Translation {
  locale: Locale;
  title: string;
  summary: string | null;
  description: string | null;
  slug: string;
  seo_title: string | null;
  seo_description: string | null;
  status: 'draft' | 'reviewed' | 'published' | 'stale';
}
interface Price {
  id: string;
  currency: string;
  amount_minor: string;
  interval: 'one_time' | 'monthly' | 'yearly';
  effective_from: string;
  effective_to: string | null;
}
interface Plan {
  id: string;
  code: string;
  deployment_mode: 'selfhost' | 'hosted';
  name_json: Record<string, string>;
  status: 'draft' | 'active' | 'archived';
  limits_json: Record<string, unknown>;
  row_version: number;
  prices: Price[];
}
interface Version {
  id: string;
  semver: string;
  adapter: string;
  status: string;
  source_sha: string;
  created_at: string;
  preview_label: string | null;
}
interface Detail {
  id: string;
  slug: string;
  status: string;
  category_id: string | null;
  published_version_id: string | null;
  translations: Translation[];
  versions: Version[];
  plans: Plan[];
  publish: { ready: boolean; gates: { code: string; passed: boolean }[] };
}

function TranslationForm({ templateId, locale, existing, onSaved }: { templateId: string; locale: Locale; existing: Translation | undefined; onSaved: () => void }) {
  const { t } = useT();
  const fieldError = useFieldError();
  const [form, setForm] = useState(() => ({
    title: existing?.title ?? '',
    slug: existing?.slug ?? '',
    summary: existing?.summary ?? '',
    description: existing?.description ?? '',
    seo_title: existing?.seo_title ?? '',
    seo_description: existing?.seo_description ?? '',
    status: existing?.status === 'stale' ? 'draft' : (existing?.status ?? 'draft'),
  }));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    setError(null);
    const res = await api(`/admin/templates/${templateId}/translations/${locale}`, {
      method: 'PUT',
      body: {
        title: form.title.trim(),
        slug: form.slug.trim(),
        summary: form.summary.trim() || undefined,
        description: form.description.trim() || undefined,
        seo_title: form.seo_title.trim() || undefined,
        seo_description: form.seo_description.trim() || undefined,
        status: form.status,
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDirty(false);
    setSaved(true);
    onSaved();
  }

  return (
    <div className="stack">
      {error ? <ErrorState error={error} /> : null}
      {error?.code === 'translation.slug_taken' ? <Alert tone="error"><p>{t('ui.template_edit.slug_taken')}</p></Alert> : null}
      {saved ? <Alert tone="success" live><p>{t('ui.template_edit.saved')}</p></Alert> : null}
      <FormField label={t('ui.template_edit.title')} error={fieldError(fieldErrorFor(error, 'title'))}>
        {(p) => <input {...p} className="input" lang={locale} value={form.title} onChange={set('title')} maxLength={200} />}
      </FormField>
      <FormField label={t('ui.template_edit.slug')} hint={t('ui.template_edit.slug_hint')} error={fieldError(fieldErrorFor(error, 'slug'))}>
        {(p) => <input {...p} className="input mono" value={form.slug} onChange={set('slug')} pattern="[a-z0-9]+(-[a-z0-9]+)*" />}
      </FormField>
      <FormField label={t('ui.template_edit.summary')}>
        {(p) => <textarea {...p} className="textarea" lang={locale} rows={2} value={form.summary} onChange={set('summary')} maxLength={500} />}
      </FormField>
      <FormField label={t('ui.template_edit.description')}>
        {(p) => <textarea {...p} className="textarea" lang={locale} rows={5} value={form.description} onChange={set('description')} maxLength={20000} />}
      </FormField>
      <FormField label={t('ui.template_edit.seo_title')}>
        {(p) => <input {...p} className="input" lang={locale} value={form.seo_title} onChange={set('seo_title')} maxLength={200} />}
      </FormField>
      <FormField label={t('ui.template_edit.seo_description')}>
        {(p) => <textarea {...p} className="textarea" lang={locale} rows={2} value={form.seo_description} onChange={set('seo_description')} maxLength={400} />}
      </FormField>
      <FormField label={t('ui.template_edit.translation_status')}>
        {(p) => (
          <select {...p} className="select" value={form.status} onChange={set('status')}>
            <option value="draft">{t('ui.locale_status.draft')}</option>
            <option value="reviewed">{t('ui.locale_status.reviewed')}</option>
            <option value="published">{t('ui.locale_status.published')}</option>
          </select>
        )}
      </FormField>
      <div className="row">
        <button type="button" className="button" disabled={busy || !form.title || !form.slug} onClick={() => void save()}>
          {busy ? t('ui.state.saving') : t('ui.template_edit.save_translation')}
        </button>
        {dirty ? <span className="muted">{t('ui.state.unsaved')}</span> : null}
      </div>
    </div>
  );
}

function AddPlan({ templateId, onAdded }: { templateId: string; onAdded: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'selfhost' | 'hosted'>('selfhost');
  const [nameVi, setNameVi] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const res = await api(`/admin/templates/${templateId}/plans`, { method: 'POST', body: { code: code.trim(), deployment_mode: mode, name: { vi: nameVi.trim() } } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setOpen(false);
    setCode('');
    setNameVi('');
    onAdded();
  }

  if (!open) return <button type="button" className="button button--secondary" onClick={() => setOpen(true)}>{t('ui.plan.add')}</button>;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{t('ui.plan.add')}</h3>
      {error ? <ErrorState error={error} /> : null}
      {error?.code === 'plan.code_taken' ? <Alert tone="error"><p>{t('ui.plan.code_taken')}</p></Alert> : null}
      <FormField label={t('ui.plan.code')} hint={t('ui.plan.code_hint')}>
        {(p) => <input {...p} className="input mono" value={code} onChange={(e) => setCode(e.target.value)} pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" />}
      </FormField>
      <FormField label={t('ui.plan.mode')}>
        {(p) => (
          <select {...p} className="select" value={mode} onChange={(e) => setMode(e.target.value as 'selfhost' | 'hosted')}>
            <option value="selfhost">{t('ui.deployment.selfhost')}</option>
            <option value="hosted">{t('ui.deployment.hosted')}</option>
          </select>
        )}
      </FormField>
      <FormField label={t('ui.plan.name_vi')}>
        {(p) => <input {...p} className="input" value={nameVi} onChange={(e) => setNameVi(e.target.value)} maxLength={120} />}
      </FormField>
      <div className="row">
        <button type="button" className="button" disabled={busy || !code || !nameVi} onClick={() => void add()}>{t('ui.plan.create')}</button>
        <button type="button" className="button button--secondary" onClick={() => setOpen(false)}>{t('ui.action.cancel')}</button>
      </div>
    </div>
  );
}

function PlanCard({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const { t, dt, locale } = useT();
  const [amount, setAmount] = useState('');
  const [interval, setInterval] = useState<'one_time' | 'monthly' | 'yearly'>(plan.deployment_mode === 'hosted' ? 'monthly' : 'one_time');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const now = Date.now();
  const current = plan.prices.filter((p) => Date.parse(p.effective_from) <= now && (!p.effective_to || Date.parse(p.effective_to) > now));

  async function addPrice() {
    if (!/^\d+$/.test(amount)) return setError({ code: 'validation.failed', message: t('ui.plan.amount_invalid'), field_errors: [], request_id: null, retryable: false });
    setBusy(true);
    setError(null);
    const res = await api(`/admin/plans/${plan.id}/prices`, { method: 'POST', body: { amount_minor: amount, interval } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setAmount('');
    onChanged();
  }

  async function setStatus(status: 'active' | 'archived' | 'draft') {
    setBusy(true);
    setError(null);
    const res = await api(`/admin/plans/${plan.id}`, { method: 'PATCH', ifMatch: `"${plan.row_version}"`, body: { status } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onChanged();
  }

  const planTone = plan.status === 'active' ? 'success' : plan.status === 'archived' ? 'neutral' : 'warning';
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{plan.name_json[locale] ?? plan.name_json.vi ?? plan.code}</strong> <span className="mono muted">{plan.code}</span>
          <div><span className="badge badge--neutral">{t(`ui.deployment.${plan.deployment_mode}`)}</span> <StatusBadge tone={planTone}>{t(`ui.plan.status.${plan.status}`)}</StatusBadge></div>
        </div>
        <div className="row">
          {plan.status !== 'active' ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void setStatus('active')}>{t('ui.plan.activate')}</button> : null}
          {plan.status === 'active' ? <button type="button" className="button button--secondary" disabled={busy} onClick={() => void setStatus('archived')}>{t('ui.plan.archive')}</button> : null}
        </div>
      </div>
      {error ? <ErrorState error={error} /> : null}
      {error?.code === 'plan.no_current_price' ? <Alert tone="warning"><p>{t('ui.plan.need_price')}</p></Alert> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('ui.plan.col_interval')}</th>
              <th scope="col">{t('ui.plan.col_amount')}</th>
              <th scope="col">{t('ui.plan.col_effective')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.prices.length === 0 ? (
              <tr><td colSpan={3} className="muted">{t('ui.plan.no_prices')}</td></tr>
            ) : (
              plan.prices.map((price) => {
                const isCurrent = current.some((c) => c.id === price.id);
                return (
                  <tr key={price.id}>
                    <td>{t(`ui.price.${price.interval}`)}</td>
                    <td className="tabular">{formatMoney(price, locale)} {isCurrent ? <StatusBadge tone="success">{t('ui.plan.current')}</StatusBadge> : null}</td>
                    <td className="tabular muted">{dt(price.effective_from)}{price.effective_to ? ` → ${dt(price.effective_to)}` : ''}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <FormField label={t('ui.plan.add_amount')} hint={t('ui.plan.amount_hint')}>
          {(p) => <input {...p} className="input tabular" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />}
        </FormField>
        <FormField label={t('ui.plan.col_interval')}>
          {(p) => (
            <select {...p} className="select" value={interval} onChange={(e) => setInterval(e.target.value as typeof interval)}>
              <option value="one_time">{t('ui.price.one_time')}</option>
              <option value="monthly">{t('ui.price.monthly')}</option>
              <option value="yearly">{t('ui.price.yearly')}</option>
            </select>
          )}
        </FormField>
        <button type="button" className="button button--secondary" disabled={busy || !amount} onClick={() => void addPrice()}>{t('ui.plan.add_price')}</button>
      </div>
    </div>
  );
}

function TemplateDetailInner() {
  const { t, dt } = useT();
  const me = useCurrentUser();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<Detail>(`/admin/templates/${id}/detail`);
    if (res.ok) {
      setDetail(res.data);
      setEtag(res.etag);
    } else setError(res.error);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    setBusy(true);
    setActionError(null);
    const res = await api(`/admin/templates/${id}/publish`, { method: 'POST', ifMatch: etag });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    await load();
  }
  async function archive() {
    if (!window.confirm(t('ui.template_edit.archive_confirm'))) return;
    setBusy(true);
    setActionError(null);
    const res = await api(`/admin/templates/${id}/archive`, { method: 'POST', ifMatch: etag });
    setBusy(false);
    if (!res.ok) return setActionError(res.error);
    await load();
  }

  if (error && !detail) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!detail) return <Loading />;

  const canPublish = me.permissions.includes('template:publish');
  const canPrice = me.permissions.includes('pricing:write');
  const canTranslate = me.permissions.includes('translation:write');
  const title = detail.translations.find((tr) => tr.locale === 'vi')?.title ?? detail.slug;
  const localeStatus = (locale: Locale): LocaleStatus => {
    const tr = detail.translations.find((x) => x.locale === locale);
    return tr ? (tr.status as LocaleStatus) : 'missing';
  };

  return (
    <div className="stack">
      <p><Link href="/admin/templates">← {t('ui.admin.templates.title')}</Link></p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        <StatusBadge tone={templateTone(detail.status)}>{t(`ui.template.status.${detail.status}`)}</StatusBadge>
      </div>

      {/* A09 — publish gates */}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.template_edit.publish')}</h2>
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {detail.publish.gates.map((gate) => (
            <li key={gate.code} className="row">
              <StatusBadge tone={gate.passed ? 'success' : 'error'}>{gate.passed ? t('ui.state.done') : t('ui.template_edit.gate_blocked')}</StatusBadge>
              <span>{t(`ui.publish_gate.${gate.code}`)}</span>
            </li>
          ))}
        </ul>
        {actionError ? <ErrorState error={actionError} /> : null}
        {actionError?.code === 'template.publish_gate_failed' ? <Alert tone="error"><p>{t('ui.template_edit.gate_failed')}</p></Alert> : null}
        <div className="row">
          {canPublish && detail.status !== 'published' ? (
            <button type="button" className="button" disabled={busy || !detail.publish.ready} onClick={() => void publish()} aria-describedby={!detail.publish.ready ? 'publish-hint' : undefined}>
              {t('ui.template_edit.publish_action')}
            </button>
          ) : null}
          {canPublish && detail.status === 'published' ? (
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void archive()}>{t('ui.template_edit.archive_action')}</button>
          ) : null}
        </div>
        {!detail.publish.ready && detail.status !== 'published' ? <p id="publish-hint" className="field__hint">{t('ui.template_edit.publish_hint')}</p> : null}
      </section>

      {/* A06 — localized metadata */}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.template_edit.content')}</h2>
        {canTranslate ? (
          <LocaleTabs statusFor={localeStatus} render={(locale) => <TranslationForm key={locale} templateId={id} locale={locale} existing={detail.translations.find((x) => x.locale === locale)} onSaved={() => void load()} />} />
        ) : (
          <p className="muted">{t('ui.template_edit.no_translate_permission')}</p>
        )}
      </section>

      {/* A08 — plans and pricing */}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.template_edit.plans')}</h2>
        {detail.plans.length === 0 ? <p className="muted">{t('ui.plan.empty')}</p> : null}
        {detail.plans.map((plan) => (canPrice ? <PlanCard key={plan.id} plan={plan} onChanged={() => void load()} /> : (
          <div key={plan.id} className="card"><strong>{plan.name_json.vi ?? plan.code}</strong> · <StatusBadge tone="neutral">{t(`ui.plan.status.${plan.status}`)}</StatusBadge></div>
        )))}
        {canPrice ? <AddPlan templateId={id} onAdded={() => void load()} /> : null}
      </section>

      {/* Versions (read-only summary; full SHA/artifact/import view on the versions page) */}
      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.template_edit.versions')}</h2>
        <p style={{ margin: 0 }}><Link href={`/admin/templates/${id}/versions`}>{t('ui.admin.versions_open')}</Link></p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('ui.template_edit.version')}</th>
                <th scope="col">{t('ui.admin.imports.col_status')}</th>
                <th scope="col">{t('ui.import.detail.created')}</th>
                <th scope="col"><span className="visually-hidden">{t('ui.table.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((v) => (
                <tr key={v.id}>
                  <td><span className="mono">{v.semver}</span> · {v.adapter}</td>
                  <td><StatusBadge tone={v.status === 'published' ? 'success' : 'neutral'}>{v.status}</StatusBadge></td>
                  <td className="tabular">{dt(v.created_at)}</td>
                  <td>{v.preview_label ? <span className="muted">{t('ui.template_edit.has_preview')}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function TemplateDetailPage() {
  return (
    <RequirePermission permission="template:read">
      <TemplateDetailInner />
    </RequirePermission>
  );
}
