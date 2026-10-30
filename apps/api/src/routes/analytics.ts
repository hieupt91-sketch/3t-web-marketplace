import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../app.ts';

/**
 * First-party storefront statistics (owner request): a tiny beacon the
 * public pages fire per view, and the admin overview that aggregates it.
 * Deliberately privacy-light — no cookies, no raw IPs, no cross-day
 * tracking (the visitor hash rotates daily) — and bot traffic is
 * dropped at the door so the numbers reflect people, not crawlers.
 */

const BOT_UA = /bot|crawl|spider|slurp|preview|headless/i;
const TRACKED_PREFIXES = ['/', '/templates', '/plans', '/how-it-works', '/help'];

function slugFromPath(path: string): string | null {
  const m = /^\/templates\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  return m ? m[1]! : null;
}

export async function publicAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.post<{ Body: { path?: string } }>(
    '/analytics/pageview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { path: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (request, reply) => {
      const raw = typeof request.body?.path === 'string' ? request.body.path : '';
      const path = raw.split('?')[0]!.split('#')[0]!;
      const ua = request.headers['user-agent'] ?? '';
      const tracked = path.startsWith('/') && !path.startsWith('//') && TRACKED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || (p === '/' && path === '/'));
      if (!tracked || BOT_UA.test(ua)) return reply.status(204).send();
      const day = new Date().toISOString().slice(0, 10);
      const visitorKey = createHash('sha256').update(`${request.ip}|${ua}|${day}`).digest('hex').slice(0, 32);
      await db.query('INSERT INTO pageviews (path, template_slug, visitor_key) VALUES ($1, $2, $3)', [path, slugFromPath(path), visitorKey]);
      return reply.status(204).send();
    },
  );
}

interface DayRow { day: string; views: number; visitors: number }

export async function adminStatsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get<{ Querystring: { days?: string } }>('/stats/overview', async (request) => {
    requirePermission(request, 'report:read');
    const days = request.query.days === '7' ? 7 : 30;
    const tz = 'Asia/Saigon';
    // Day boundaries are Asia/Saigon civil days. Vietnam is UTC+7 with no
    // DST, so the boundary math is a fixed +07:00 offset computed in JS —
    // named-zone lookups in SQL depend on the server's tz database, which
    // minimal Postgres builds may not ship (that broke this route once).
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const saigonToday = fmt.format(new Date());
    const startMs = Date.parse(`${saigonToday}T00:00:00+07:00`) - (days - 1) * 86_400_000;
    const startIso = new Date(startMs).toISOString();
    const SAIGON_DAY = `((created_at AT TIME ZONE 'UTC') + interval '7 hours')::date`;

    const daily = await db.query<DayRow>(
      `SELECT ${SAIGON_DAY}::text AS day, COUNT(*)::int AS views, COUNT(DISTINCT visitor_key)::int AS visitors
       FROM pageviews
       WHERE created_at >= $1
       GROUP BY 1 ORDER BY 1`,
      [startIso],
    );
    // Zero-fill the range so the chart shows quiet days honestly.
    const byDay = new Map(daily.rows.map((r) => [r.day, r]));
    const series: DayRow[] = [];
    for (let j = 0; j < days; j++) {
      const key = fmt.format(new Date(startMs + j * 86_400_000));
      series.push(byDay.get(key) ?? { day: key, views: 0, visitors: 0 });
    }
    const today = series[series.length - 1]!;
    const last7 = series.slice(-7);
    const sum = (rows: DayRow[], f: 'views' | 'visitors') => rows.reduce((a, r) => a + r[f], 0);

    const topPages = await db.query<{ path: string; views: number }>(
      `SELECT path, COUNT(*)::int AS views FROM pageviews
       WHERE created_at >= $1
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [startIso],
    );
    const topTemplates = await db.query<{ slug: string; views: number }>(
      `SELECT template_slug AS slug, COUNT(*)::int AS views FROM pageviews
       WHERE template_slug IS NOT NULL AND created_at >= $1
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [startIso],
    );
    const orders = await db.query<{ created_range: number; today_count: number; revenue_range: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= $1)::int AS created_range,
         COUNT(*) FILTER (WHERE ${SAIGON_DAY}::text = $2)::int AS today_count,
         COALESCE(SUM(total_minor) FILTER (WHERE paid_at IS NOT NULL AND paid_at >= $1), 0)::text AS revenue_range
       FROM orders`,
      [startIso, saigonToday],
    );
    const o = orders.rows[0]!;
    return {
      data: {
        range_days: days,
        views_today: today.views,
        visitors_today: today.visitors,
        views_7d: sum(last7, 'views'),
        visitors_7d: sum(last7, 'visitors'),
        views_range: sum(series, 'views'),
        visitors_range: sum(series, 'visitors'),
        daily: series,
        top_pages: topPages.rows,
        top_templates: topTemplates.rows,
        orders_range: o.created_range,
        orders_today: o.today_count,
        revenue_range_minor: o.revenue_range,
      },
    };
  });
}
