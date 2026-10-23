'use client';

import { useEffect, useState } from 'react';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Overview {
  imports_by_status: Record<string, number>;
  templates_by_status: Record<string, number>;
  jobs_by_status: Record<string, number>;
  generated_at: string;
}

function Counts({ title, data, prefix }: { title: string; data: Record<string, number>; prefix: string }) {
  const { t } = useT();
  const entries = Object.entries(data);
  return (
    <section className="card stack">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {entries.length === 0 ? (
        <p className="muted">{t('ui.admin.overview.none')}</p>
      ) : (
        <dl className="details">
          {entries.map(([status, n]) => (
            <div key={status} style={{ display: 'contents' }}>
              <dt>{t(`${prefix}.${status}`)}</dt>
              <dd className="tabular">{n}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** A01 — only metrics the platform records today; revenue/partner cards arrive with M4/M6. */
function OverviewInner() {
  const { t, dt } = useT();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    void api<Overview>('/admin/overview').then((res) => (res.ok ? setData(res.data) : setError(res.error)));
  }, []);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.admin.overview.title')}</h1>
      <p className="muted">{t('ui.admin.overview.generated', { time: dt(data.generated_at) })}</p>
      <div className="grid-cards">
        <Counts title={t('ui.admin.overview.imports')} data={data.imports_by_status} prefix="ui.import.status" />
        <Counts title={t('ui.admin.overview.templates')} data={data.templates_by_status} prefix="ui.template.status" />
        <Counts title={t('ui.admin.overview.jobs')} data={data.jobs_by_status} prefix="ui.job.status" />
      </div>
    </div>
  );
}

export default function AdminOverview() {
  return (
    <RequirePermission permission="report:read">
      <OverviewInner />
    </RequirePermission>
  );
}
