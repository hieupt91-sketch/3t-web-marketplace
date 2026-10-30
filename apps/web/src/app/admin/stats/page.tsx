'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatMoney } from '@3t/i18n';
import { RequirePermission } from '@/components/dashboard-shell';
import { ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface DayRow { day: string; views: number; visitors: number }
interface Stats {
  range_days: number;
  views_today: number;
  visitors_today: number;
  views_7d: number;
  visitors_7d: number;
  views_range: number;
  visitors_range: number;
  daily: DayRow[];
  top_pages: { path: string; views: number }[];
  top_templates: { slug: string; views: number }[];
  orders_range: number;
  orders_today: number;
  revenue_range_minor: string;
}

function StatsInner() {
  const { t, locale } = useT();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setStats(null);
    void api<Stats>(`/admin/stats/overview?days=${days}`).then((res) => {
      if (res.ok) setStats(res.data);
      else setError(res.error);
    });
  }, [days]);

  if (error && !stats) return <ErrorState error={error} />;
  if (!stats) return <Loading />;

  const maxViews = Math.max(1, ...stats.daily.map((d) => d.views));
  const fmtDay = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('ui.stats.title')}</h1>
        <div className="row" role="group" aria-label={t('ui.stats.range_label')}>
          {[7, 30].map((d) => (
            <button key={d} type="button" className={`button ${days === d ? '' : 'button--secondary'}`} onClick={() => setDays(d)}>
              {t('ui.stats.range_days', { days: String(d) })}
            </button>
          ))}
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.stats.hint')}</p>
      {error ? <ErrorState error={error} /> : null}

      <div className="grid-cards">
        <div className="card stack">
          <span className="muted">{t('ui.stats.views_today')}</span>
          <strong style={{ fontSize: 30 }}>{stats.views_today.toLocaleString(locale)}</strong>
          <span className="muted">{t('ui.stats.visitors')}: {stats.visitors_today.toLocaleString(locale)}</span>
        </div>
        <div className="card stack">
          <span className="muted">{t('ui.stats.views_7d')}</span>
          <strong style={{ fontSize: 30 }}>{stats.views_7d.toLocaleString(locale)}</strong>
          <span className="muted">{t('ui.stats.visitors')}: {stats.visitors_7d.toLocaleString(locale)}</span>
        </div>
        <div className="card stack">
          <span className="muted">{t('ui.stats.views_range', { days: String(stats.range_days) })}</span>
          <strong style={{ fontSize: 30 }}>{stats.views_range.toLocaleString(locale)}</strong>
          <span className="muted">{t('ui.stats.visitors')}: {stats.visitors_range.toLocaleString(locale)}</span>
        </div>
        <div className="card stack">
          <span className="muted">{t('ui.stats.orders_range', { days: String(stats.range_days) })}</span>
          <strong style={{ fontSize: 30 }}>{stats.orders_range.toLocaleString(locale)}</strong>
          <span className="muted">{t('ui.stats.orders_today')}: {stats.orders_today}</span>
        </div>
        <div className="card stack">
          <span className="muted">{t('ui.stats.revenue_range', { days: String(stats.range_days) })}</span>
          <strong style={{ fontSize: 24 }}>{formatMoney({ amount_minor: stats.revenue_range_minor, currency: 'VND' }, locale)}</strong>
          <span className="muted">{t('ui.stats.revenue_note')}</span>
        </div>
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t('ui.stats.daily_title')}</h2>
        <div className="stats-bars" role="img" aria-label={t('ui.stats.daily_title')}>
          {stats.daily.map((d) => (
            <div key={d.day} className="stats-bar" title={`${d.day}: ${d.views} ${t('ui.stats.views_unit')} · ${d.visitors} ${t('ui.stats.visitors')}`}>
              <span className="stats-bar__fill" style={{ height: `${Math.max(2, Math.round((d.views / maxViews) * 100))}%` }} />
              <span className="stats-bar__label">{fmtDay(d.day)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid-cards">
        <section className="card stack">
          <h2 style={{ margin: 0 }}>{t('ui.stats.top_pages')}</h2>
          {stats.top_pages.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('ui.stats.empty')}</p> : (
            <table className="table">
              <tbody>
                {stats.top_pages.map((p) => (
                  <tr key={p.path}><td className="mono">{p.path}</td><td className="tabular" style={{ textAlign: 'end' }}>{p.views.toLocaleString(locale)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card stack">
          <h2 style={{ margin: 0 }}>{t('ui.stats.top_templates')}</h2>
          {stats.top_templates.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('ui.stats.empty')}</p> : (
            <table className="table">
              <tbody>
                {stats.top_templates.map((x) => (
                  <tr key={x.slug}>
                    <td><Link href={`/${locale}/templates/${x.slug}`}>{x.slug}</Link></td>
                    <td className="tabular" style={{ textAlign: 'end' }}>{x.views.toLocaleString(locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

export default function StatsPage() {
  return (
    <RequirePermission permission="report:read">
      <StatsInner />
    </RequirePermission>
  );
}
