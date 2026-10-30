import { hashPassword } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, sessionCookie, type TestContext } from './test-helpers.ts';

/** Storefront statistics: the beacon drops bots and untracked paths, the
 *  overview aggregates by Asia/Saigon civil day WITHOUT relying on the
 *  server's named-zone database (regression: a minimal Postgres build
 *  answered "time zone Asia/Saigon not recognized" and the route 500'd). */
let ctx: TestContext;
let ownerCookie: string;

const HUMAN_A = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0';
const HUMAN_B = 'Mozilla/5.0 (iPhone) Safari/18.0';
const BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

async function pageview(path: string, ua: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/analytics/pageview',
    headers: { origin: 'http://localhost:3000', 'user-agent': ua },
    payload: { path },
  });
}

beforeAll(async () => {
  ctx = await createTestContext({});
  const password = 'correct horse battery staple';
  const { rows } = await ctx.db.query<{ id: string }>(
    "INSERT INTO users (email_normalized, display_name, password_hash, verified_at) VALUES ('stats-owner@example.com', 'Owner', $1, now()) RETURNING id",
    [await hashPassword(password, 1024)],
  );
  await ctx.db.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0]!.id, 'platform_owner']);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://localhost:3000' },
    payload: { email: 'stats-owner@example.com', password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  ownerCookie = sessionCookie(res);
});

afterAll(async () => {
  await ctx.close();
});

describe('stats overview', () => {
  it('counts human views and visitors, drops bots and untracked paths', async () => {
    expect((await pageview('/', HUMAN_A)).statusCode).toBe(204);
    expect((await pageview('/templates/landing-saas', HUMAN_A)).statusCode).toBe(204);
    expect((await pageview('/', HUMAN_B)).statusCode).toBe(204);
    expect((await pageview('/', BOT)).statusCode).toBe(204);
    expect((await pageview('/checkout/orders/x/pay', HUMAN_A)).statusCode).toBe(204);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats/overview?days=7',
      headers: { origin: 'http://localhost:3000', cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.views_today).toBe(3);
    expect(data.visitors_today).toBe(2);
    expect(data.views_range).toBe(3);
    expect(data.daily).toHaveLength(7);
    expect(data.daily[data.daily.length - 1].views).toBe(3);
    expect(data.top_templates).toEqual([{ slug: 'landing-saas', views: 1 }]);
    expect(data.top_pages[0]).toEqual({ path: '/', views: 2 });
  });

  it('requires report:read (anonymous is rejected)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/stats/overview', headers: { origin: 'http://localhost:3000' } });
    expect(res.statusCode).toBe(401);
  });
});
