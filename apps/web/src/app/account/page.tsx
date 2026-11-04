'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { useCurrentUser } from '@/components/dashboard-shell';
import { Alert, EmptyState, ErrorState, Loading, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { isDynamicAdapter } from '@/lib/template-kind';

interface TodoItem { [key: string]: string | number | null }
interface TodoGroup { kind: string; count: number; items: TodoItem[] }
interface Todos { total: number; groups: TodoGroup[] }

/** ACC-01: the "việc cần làm" block — only actionable items, each linking
 *  to the screen that resolves it. Renders nothing when there is nothing
 *  to do, so a settled account sees a clean home. */
function TodoBlock() {
  const { t, dt, locale } = useT();
  const [todos, setTodos] = useState<Todos | null>(null);
  useEffect(() => {
    void api<Todos>('/me/todos').then((res) => {
      if (res.ok) setTodos(res.data);
    });
  }, []);
  if (!todos || todos.total === 0) return null;

  const line = (group: TodoGroup, item: TodoItem): { text: string; href: string } => {
    switch (group.kind) {
      case 'payment_due':
        return {
          text: t('ui.todos.payment_due', { order: String(item.order_id).slice(0, 8), amount: formatMoney({ amount_minor: String(item.total_minor), currency: String(item.currency) }, locale) }),
          href: `/account/orders/${item.order_id}`,
        };
      case 'site_unfinished':
        return {
          text: item.status === 'provision_failed'
            ? t('ui.todos.site_failed', { name: String(item.display_name) })
            : t('ui.todos.site_creating', { name: String(item.display_name) }),
          href: `/account/sites/${item.site_id}`,
        };
      case 'domain_pending':
        return { text: t('ui.todos.domain_pending', { domain: String(item.hostname), name: String(item.site_name) }), href: `/account/sites/${item.site_id}/domains` };
      case 'subscription_expiring':
        return {
          text: item.sub_status === 'grace'
            ? t('ui.todos.expiring_grace', { name: String(item.site_name), date: dt(String(item.period_end)) })
            : t('ui.todos.expiring', { name: String(item.site_name), date: dt(String(item.period_end)) }),
          href: `/account/sites/${item.site_id}/billing`,
        };
      case 'ticket_waiting':
        return { text: t('ui.todos.ticket_waiting', { subject: String(item.subject) }), href: `/account/support/${item.ticket_id}` };
      case 'hosted_slots_free':
        return { text: t('ui.todos.slots_free', { count: String(item.free_slots), slug: String(item.template_slug) }), href: '/account/sites/new' };
      default:
        return { text: '', href: '/account' };
    }
  };

  return (
    <section className="card stack" aria-label={t('ui.todos.title')}>
      <h2 style={{ margin: 0 }}>{t('ui.todos.title')} ({todos.total})</h2>
      <ul className="stack" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
        {todos.groups.flatMap((group) =>
          group.items.map((item, idx) => {
            const { text, href } = line(group, item);
            return (
              <li key={`${group.kind}-${idx}`}>
                <Link href={href}>{text}</Link>
                {group.count > group.items.length && idx === group.items.length - 1 ? <span className="muted"> (+{group.count - group.items.length})</span> : null}
              </li>
            );
          }),
        )}
      </ul>
    </section>
  );
}

interface EntitlementSummary {
  id: string;
  mode: string;
  status: string;
  template: { id: string; slug: string; adapter: string | null };
  site?: { id: string; display_name: string; status: string; subdomain: string | null } | null;
}
interface SiteSummary { id: string; display_name: string; subdomain: string | null; status: string; url: string | null }

/** C01 — what the customer actually owns: purchased templates
 *  (GET /me/entitlements — the same data the purchases page renders)
 *  and their sites (GET /sites). Compact summary only; the detail
 *  lives on /account/purchases and /account/sites. The "no purchases"
 *  empty state renders ONLY when both lists are truly empty — it used
 *  to render unconditionally, telling every buyer they owned nothing. */
function LibrarySummary() {
  const { t, locale } = useT();
  const [ents, setEnts] = useState<EntitlementSummary[] | null>(null);
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const [e, s] = await Promise.all([api<EntitlementSummary[]>('/me/entitlements'), api<SiteSummary[]>('/sites')]);
    if (e.ok && s.ok) {
      setEnts(e.data);
      setSites(s.data);
      setError(null);
    } else if (!e.ok) setError(e.error);
    else if (!s.ok) setError(s.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && (!ents || !sites)) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!ents || !sites) return <Loading />;
  if (ents.length === 0 && sites.length === 0) {
    return (
      <EmptyState title={t('ui.account.purchases_empty_title')} action={<Link className="button" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>}>
        <p>{t('ui.account.purchases_empty_body')}</p>
      </EmptyState>
    );
  }
  return (
    <>
      {ents.length > 0 ? (
        <section className="card stack" aria-label={t('ui.account.nav.purchases')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.account.nav.purchases')} ({ents.length})</h2>
            <Link href="/account/purchases">{t('ui.account.overview_all')}</Link>
          </div>
          <ul className="stack" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
            {ents.slice(0, 5).map((e) => (
              <li key={e.id}>
                <Link href="/account/purchases"><span className="mono">{e.template.slug}</span></Link>{' '}
                <StatusBadge tone={isDynamicAdapter(e.template.adapter) ? 'info' : 'neutral'}>
                  {isDynamicAdapter(e.template.adapter) ? t('ui.catalog.kind_dynamic') : t('ui.catalog.kind_static')}
                </StatusBadge>{' '}
                <StatusBadge tone={e.status === 'active' ? 'success' : 'neutral'}>{t(`ui.entitlement.status.${e.status}`)}</StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sites.length > 0 ? (
        <section className="card stack" aria-label={t('ui.account.nav.sites')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t('ui.account.nav.sites')} ({sites.length})</h2>
            <Link href="/account/sites">{t('ui.account.overview_all')}</Link>
          </div>
          <ul className="stack" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
            {sites.slice(0, 5).map((s) => (
              <li key={s.id}>
                <Link href={s.status === 'creating' || s.status === 'provision_failed' ? `/account/sites/${s.id}/creating` : `/account/sites/${s.id}`}>{s.display_name}</Link>{' '}
                <StatusBadge tone={s.status === 'active' ? 'success' : 'neutral'}>{t(`ui.sites.status.${s.status}`)}</StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** C01 — customer home: todo block, then the library summary. */
export default function AccountHome() {
  const me = useCurrentUser();
  const { t } = useT();
  return (
    <div className="stack">
      <h1>{t('ui.account.title', { name: me.display_name })}</h1>
      {!me.verified ? (
        <Alert tone="warning" title={t('ui.account.unverified_title')}>
          <p>{t('ui.account.unverified_body')}</p>
          <p><Link href="/auth/verify">{t('ui.auth.verify.resend_link')}</Link></p>
        </Alert>
      ) : null}
      <TodoBlock />
      <LibrarySummary />
    </div>
  );
}
