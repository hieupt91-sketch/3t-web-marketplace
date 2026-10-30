'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { useCurrentUser } from '@/components/dashboard-shell';
import { Alert, EmptyState } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

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

/** C01 — customer home. Purchases/sites appear once commerce (M4) and hosting (M5) exist. */
export default function AccountHome() {
  const me = useCurrentUser();
  const { t, locale } = useT();
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
      <EmptyState title={t('ui.account.purchases_empty_title')} action={<Link className="button" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>}>
        <p>{t('ui.account.purchases_empty_body')}</p>
      </EmptyState>
    </div>
  );
}
