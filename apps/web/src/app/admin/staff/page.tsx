'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
interface Staff { id: string; email: string; display_name: string; status: string; roles: string[]; mfa_enabled: boolean }

function StaffInner() {
  const { t } = useT();
  const [rows, setRows] = useState<Staff[]>([]);
  const [userId, setUserId] = useState('');
  const [roleCode, setRoleCode] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => {
    const res = await api<Staff[]>('/admin/staff');
    if (!res.ok) return setError(res.error);
    setRows(res.data); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function grant(e: React.FormEvent) {
    e.preventDefault();
    const res = await api(`/admin/staff/${userId}/roles`, { method: 'POST', body: { role_code: roleCode } });
    if (!res.ok) return setError(res.error);
    void load();
  }
  async function revoke(id: string, role: string) {
    const res = await api(`/admin/staff/${id}/roles/${role}`, { method: 'DELETE' });
    if (!res.ok) return setError(res.error);
    void load();
  }
  if (error && !loaded) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!loaded) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.staff')}</h1>
      {error ? <ErrorState error={error} /> : null}
      <form onSubmit={grant} className="stack">
        <label>{t('ui.admin.staff_user')}<input value={userId} onChange={(e) => setUserId(e.target.value)} required placeholder="user id" /></label>
        <label>{t('ui.admin.staff_role')}<input value={roleCode} onChange={(e) => setRoleCode(e.target.value)} required placeholder="support_staff" /></label>
        <button className="button">{t('ui.admin.staff_grant')}</button>
      </form>
      {rows.length === 0 ? <EmptyState title={t('ui.admin.staff')}><p>—</p></EmptyState> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('ui.admin.staff_user')}</th><th>{t('ui.admin.staff_role')}</th><th>{t('ui.mfa.title')}</th><th>{t('ui.table.actions')}</th></tr></thead>
        <tbody>{rows.map((r) => (<tr key={r.id}><td>{r.email}</td><td>{r.roles.join(', ')}</td><td>{r.mfa_enabled ? 'on' : 'off'}</td><td>{r.roles.map((role) => (<button key={role} className="button button--danger" onClick={() => void revoke(r.id, role)}>{role} ×</button>))}</td></tr>))}</tbody></table></div>
      )}
    </div>
  );
}

export default function AdminStaff() {
  return <RequirePermission permission="staff:manage"><StaffInner /></RequirePermission>;
}
