'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { formatMoney } from '@3t/i18n';

interface SetupInfoData {
  business_name: string;
  phone?: string; email?: string; address?: string; about?: string;
  logo_url?: string; facebook_url?: string; zalo?: string;
  google_sheet_url?: string; note?: string;
  seo_title?: string; seo_description?: string;
}

interface ServiceTask {
  id: string; order_id: string; kind: string; status: string;
  created_at: string; completed_at: string | null;
  buyer_email: string; order_total_minor: string; currency: string;
  setup_info_json: SetupInfoData | null;
  setup_info_submitted_at: string | null;
}

const SETUP_INFO_FIELDS: { key: keyof SetupInfoData; label: string }[] = [
  { key: 'business_name', label: 'ui.setup_info.field_business_name' },
  { key: 'phone', label: 'ui.setup_info.field_phone' },
  { key: 'email', label: 'ui.setup_info.field_email' },
  { key: 'address', label: 'ui.setup_info.field_address' },
  { key: 'about', label: 'ui.setup_info.field_about' },
  { key: 'logo_url', label: 'ui.setup_info.field_logo_url' },
  { key: 'facebook_url', label: 'ui.setup_info.field_facebook_url' },
  { key: 'zalo', label: 'ui.setup_info.field_zalo' },
  { key: 'google_sheet_url', label: 'ui.setup_info.field_google_sheet_url' },
  { key: 'note', label: 'ui.setup_info.field_note' },
  { key: 'seo_title', label: 'ui.setup_info.field_seo_title' },
  { key: 'seo_description', label: 'ui.setup_info.field_seo_description' },
];

/** Operations queue for paid service packages (today: installation).
 *  Staff work pending tasks and mark them done; the buyer follows the
 *  status on their order. */
function ServiceTasksInner() {
  const { t, dt, locale } = useT();
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [tasks, setTasks] = useState<ServiceTask[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await api<ServiceTask[]>(`/admin/service-tasks?status=${tab}`);
    if (res.ok) setTasks(res.data); else setError(res.error);
  }, [tab]);
  useEffect(() => { setTasks(null); void load(); }, [load]);

  async function complete(id: string) {
    setBusy(id);
    const res = await api(`/admin/service-tasks/${id}/complete`, { method: 'POST', body: {} });
    setBusy('');
    if (!res.ok) setError(res.error); else void load();
  }

  return (
    <div className="stack">
      <h1>{t('ui.admin.tasks.title')}</h1>
      <div className="row">
        <button type="button" className={tab === 'pending' ? 'button' : 'button button--secondary'} onClick={() => setTab('pending')}>{t('ui.admin.tasks.tab_pending')}</button>
        <button type="button" className={tab === 'done' ? 'button' : 'button button--secondary'} onClick={() => setTab('done')}>{t('ui.admin.tasks.tab_done')}</button>
      </div>
      {error ? <ErrorState error={error} /> : null}
      {!tasks && !error ? <Loading /> : null}
      {tasks && tasks.length === 0 ? <p className="muted">{t('ui.admin.tasks.empty')}</p> : null}
      {tasks && tasks.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('ui.admin.tasks.col_kind')}</th>
                <th>{t('ui.admin.tasks.col_buyer')}</th>
                <th>{t('ui.admin.tasks.col_order_total')}</th>
                <th>{t('ui.admin.tasks.col_created')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <Fragment key={task.id}>
                  <tr>
                    <td>{t('ui.admin.tasks.kind_installation')}</td>
                    <td>{task.buyer_email}</td>
                    <td className="tabular">{formatMoney({ amount_minor: task.order_total_minor, currency: task.currency }, locale)}</td>
                    <td>{dt(task.created_at)}</td>
                    <td>
                      {task.status === 'pending' ? (
                        <button type="button" className="button button--secondary" disabled={busy === task.id} onClick={() => void complete(task.id)}>{t('ui.admin.tasks.complete')}</button>
                      ) : (
                        <span className="muted">{task.completed_at ? dt(task.completed_at) : ''}</span>
                      )}
                    </td>
                  </tr>
                  {task.setup_info_json ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="stack">
                          <strong>{t('ui.admin.tasks.setup_info_title')}</strong>
                          {task.setup_info_submitted_at ? (
                            <span className="muted">{t('ui.setup_info.submitted_at_label')}: {dt(task.setup_info_submitted_at)}</span>
                          ) : null}
                          <dl className="details">
                            {SETUP_INFO_FIELDS.map((f) => {
                              const v = task.setup_info_json?.[f.key];
                              return v ? (
                                <div key={f.key} style={{ display: 'contents' }}>
                                  <dt>{t(f.label)}</dt>
                                  <dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {f.key === 'google_sheet_url' || f.key === 'logo_url' || f.key === 'facebook_url'
                                      ? <a href={v} target="_blank" rel="noopener noreferrer">{v}</a>
                                      : v}
                                  </dd>
                                </div>
                              ) : null;
                            })}
                          </dl>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function ServiceTasksPage() {
  return <RequirePermission permission="ops:read"><ServiceTasksInner /></RequirePermission>;
}
