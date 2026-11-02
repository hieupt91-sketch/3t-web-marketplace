'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission, useCurrentUser } from '@/components/dashboard-shell';
import { Alert, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { templateTone } from '@/lib/status';

interface PageRow { id: string; slug: string; kind: string; status: string; locales: Record<string, string> | null; updated_at: string }
interface ContactRow { id: string; name: string; email: string; body: string; spam_status: string; status: string; created_at: string }

function CreateRow({ label, onCreate, extra }: { label: string; onCreate: (slug: string, extra: string) => Promise<ApiError | null>; extra?: { label: string; options: [string, string][] } }) {
  const { t } = useT();
  const [slug, setSlug] = useState('');
  const [extraVal, setExtraVal] = useState(extra?.options[0]?.[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const err = await onCreate(slug.trim(), extraVal);
    setBusy(false);
    if (err) return setError(err);
    setSlug('');
  }
  return (
    <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={submit}>
      <label className="field"><span>{label}</span><input className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" required /></label>
      {extra ? <label className="field"><span>{extra.label}</span><select className="select" value={extraVal} onChange={(e) => setExtraVal(e.target.value)}>{extra.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label> : null}
      <button type="submit" className="button button--secondary" disabled={busy || !slug}>{t('ui.content.create')}</button>
      {error ? <span className="field__error">{error.code === 'content.slug_taken' || error.code === 'policy.version_exists' ? t('ui.content.exists') : error.message}</span> : null}
    </form>
  );
}

function ContentInner() {
  const { t, dt } = useT();
  const me = useCurrentUser();
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [policies, setPolicies] = useState<{ id: string; code: string; version: string; status: string }[] | null>(null);
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const canWrite = me.permissions.includes('content:write');
  const canPolicy = me.permissions.includes('policy:manage');

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([api<PageRow[]>('/admin/content/pages'), me.permissions.includes('support:read') ? api<ContactRow[]>('/admin/content/contact-requests') : Promise.resolve(null)]);
    if (p.ok) setPages(p.data); else setError(p.error);
    if (c && c.ok) setContacts(c.data);
  }, [me.permissions]);

  useEffect(() => { void load(); }, [load]);
  // Policies have no list endpoint yet; they are reached by code/version from the public site.

  return (
    <div className="stack">
      <h1>{t('ui.admin.content.title')}</h1>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}

      <section className="card stack">
        <h2 style={{ marginTop: 0 }}>{t('ui.admin.content.pages')}</h2>
        {!pages ? <Loading /> : pages.length === 0 ? <p className="muted">{t('ui.admin.content.no_pages')}</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">{t('ui.template_edit.slug')}</th><th scope="col">{t('ui.admin.content.kind')}</th><th scope="col">{t('ui.admin.imports.col_status')}</th><th scope="col">{t('ui.admin.content.locales')}</th><th scope="col">{t('ui.import.detail.created')}</th></tr></thead>
            <tbody>{pages.map((p) => (
              <tr key={p.id}>
                <td><Link href={`/admin/content/pages/${p.id}`} className="mono">{p.slug}</Link></td>
                <td>{t(`ui.admin.content.kind_${p.kind}`)}</td>
                <td><StatusBadge tone={templateTone(p.status)}>{t(`ui.template.status.${p.status}`)}</StatusBadge></td>
                <td>{p.locales ? Object.entries(p.locales).map(([l, s]) => `${l.toUpperCase()}:${t(`ui.locale_status.${s}`)}`).join(' · ') : '—'}</td>
                <td className="tabular">{dt(p.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {canWrite ? <CreateRow label={t('ui.admin.content.new_page_slug')} extra={{ label: t('ui.admin.content.kind'), options: [['page', t('ui.admin.content.kind_page')], ['help', t('ui.admin.content.kind_help')]] }} onCreate={async (slug, kind) => {
          const res = await api<{ id: string }>('/admin/content/pages', { method: 'POST', body: { slug, kind } });
          if (res.ok) window.location.href = `/admin/content/pages/${res.data.id}`;
          return res.ok ? null : res.error;
        }} /> : null}
      </section>

      {canPolicy ? (
        <section className="card stack">
          <h2 style={{ marginTop: 0 }}>{t('ui.admin.content.policies')}</h2>
          <p className="muted">{t('ui.admin.content.policies_hint')}</p>
          <CreateRow label={t('ui.admin.content.policy_code')} extra={{ label: t('ui.admin.content.policy_version'), options: [['', '']] }} onCreate={async (code, _v) => {
            const version = window.prompt(t('ui.admin.content.policy_version')) ?? '';
            if (!version) return null;
            const res = await api<{ id: string }>('/admin/content/policies', { method: 'POST', body: { code, version } });
            if (res.ok) window.location.href = `/admin/content/policies/${res.data.id}?code=${code}`;
            return res.ok ? null : res.error;
          }} />
        </section>
      ) : null}

      {contacts ? (
        <section className="card stack">
          <h2 style={{ marginTop: 0 }}>{t('ui.admin.content.contacts')}</h2>
          {contacts.length === 0 ? <p className="muted">{t('ui.admin.content.no_contacts')}</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th scope="col">{t('ui.contact.name')}</th><th scope="col">{t('ui.auth.field.email')}</th><th scope="col">{t('ui.contact.message')}</th><th scope="col">{t('ui.import.detail.created')}</th></tr></thead>
              <tbody>{contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name} {c.spam_status === 'suspected' ? <StatusBadge tone="warning">{t('ui.admin.content.suspected')}</StatusBadge> : null}</td>
                  <td className="mono">{c.email}</td>
                  <td>{c.body.slice(0, 120)}</td>
                  <td className="tabular">{dt(c.created_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      ) : null}
    </div>
  );
}

export default function AdminContent() {
  return <RequirePermission permission="content:read"><ContentInner /></RequirePermission>;
}
