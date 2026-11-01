import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** Split packages (owner directive 2026-11-01): the web, hosting
 *  (monthly OR yearly), the domain (its own package, also buyable on
 *  its own), and the installation service are separate lines with
 *  owner-set prices only — never bundled, never invented. Buying both
 *  hosting + domain still auto-creates the site, and the owner of a
 *  dynamic site receives the one-time setup token to create their own
 *  admin account. */
let ctx: TestContext;
let ownerCookie: string;
let buyerA: { id: string; cookie: string };
let buyerB: { id: string; cookie: string };
let templateId: string;
let versionId: string;
let hostedPlanId: string;
let monthlyOnlyPlanId: string;
let selfhostPlanId: string;
const TERMS = 'terms-2026-10';
const HUB_KEY = 'packages-hub-key-1';

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });

async function settleOrder(cookie: string, quoteId: string, amount: number): Promise<string> {
  const o = await post('/api/v1/orders', { quote_id: quoteId, terms_version: TERMS }, cookie, { 'idempotency-key': randomUUID() });
  expect(o.statusCode, o.body).toBe(201);
  const orderId = o.json().data.id as string;
  const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, cookie);
  expect(s.statusCode, s.body).toBe(201);
  const code = s.json().data.instructions.content_code as string;
  const hook = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/bank_transfer',
    headers: { authorization: `Apikey ${HUB_KEY}` },
    payload: { id: Math.floor(Math.random() * 900_000_000) + 100_000_000, code, transferType: 'in', transferAmount: amount },
  });
  expect(hook.statusCode, hook.body).toBe(200);
  expect(hook.json().outcome).toBe('processed');
  return orderId;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await ctx.db.query(
    `INSERT INTO settings (key, value_json) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    [key, JSON.stringify(value)],
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'pkg-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  buyerA = await createUser(ctx, 'pkg-a@example.com');
  buyerB = await createUser(ctx, 'pkg-b@example.com');

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('packages-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu gói', 'packages-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/packages-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['d'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'd'.repeat(64), artifact.rows[0]!.id],
  );
  versionId = version.rows[0]!.id;
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [templateId, versionId]);

  const hosted = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'hosted-y', 'hosted', '{"vi":"Gói Hosting","en":"Hosting"}'::jsonb, '{"instance_limit":2}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  hostedPlanId = hosted.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 499000, 'monthly', now() - interval '1 day')",
    [hostedPlanId],
  );
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 4990000, 'yearly', now() - interval '1 day')",
    [hostedPlanId],
  );
  const monthlyOnly = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'hosted-m', 'hosted', '{"vi":"Gói Hosting tháng","en":"Monthly hosting"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  monthlyOnlyPlanId = monthlyOnly.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 300000, 'monthly', now() - interval '1 day')",
    [monthlyOnlyPlanId],
  );
  const self = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'selfhost', 'selfhost', '{"vi":"Tự cài","en":"Self-host"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  selfhostPlanId = self.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 199999, 'one_time', now() - interval '1 day')",
    [selfhostPlanId],
  );
  const bank = await post('/api/v1/admin/settings/payment', {
    enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
    account_number: '0123456789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
  }, ownerCookie);
  expect(bank.statusCode, bank.body).toBe(200);
});
afterAll(async () => ctx.close());

describe('hosting package: monthly or yearly at the buyer choice', () => {
  it('quotes the yearly price when the buyer picks yearly', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, billing_interval: 'yearly' }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data.total_minor).toBe('4990000');
    expect(q.json().data.billing_interval).toBe('yearly');
    const lines = q.json().data.line_items as { label: string; interval: string; amount_minor: string }[];
    expect(lines.some((l) => l.interval === 'yearly' && l.amount_minor === '4990000')).toBe(true);
  });

  it('refuses a yearly pick the owner has not priced, and any period pick on self-host', async () => {
    const noYearly = await post('/api/v1/quotes', { plan_id: monthlyOnlyPlanId, template_id: templateId, billing_interval: 'yearly' }, buyerA.cookie);
    expect(noYearly.statusCode).toBe(409);
    expect(noYearly.json().error.code).toBe('plan.interval_unavailable');
    const self = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, billing_interval: 'monthly' }, buyerA.cookie);
    expect(self.statusCode).toBe(422);
  });
});

describe('domain package periods', () => {
  it('charges the yearly domain price when chosen, monthly by default', async () => {
    await setSetting('subdomain.fee', { amount_minor: 10000, period: 'monthly', amount_yearly_minor: 100000 });
    const yearly = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'pkg-nam-1', display_name: 'Năm', domain_interval: 'yearly' } }, buyerA.cookie);
    expect(yearly.statusCode, yearly.body).toBe(201);
    expect(yearly.json().data.total_minor).toBe('599000');
    const lines = yearly.json().data.line_items as { label: string; interval: string; amount_minor: string }[];
    expect(lines.some((l) => l.label === 'subdomain_fee' && l.interval === 'yearly' && l.amount_minor === '100000')).toBe(true);
    const monthly = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'pkg-thang-1', display_name: 'Tháng' } }, buyerA.cookie);
    expect(monthly.json().data.total_minor).toBe('509000');
  });

  it('refuses a yearly domain pick when the owner set no yearly price', async () => {
    await setSetting('subdomain.fee', { amount_minor: 10000, period: 'monthly' });
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'pkg-nam-2', display_name: 'Năm 2', domain_interval: 'yearly' } }, buyerA.cookie);
    expect(q.statusCode).toBe(422);
    await setSetting('subdomain.fee', { amount_minor: 10000, period: 'monthly', amount_yearly_minor: 100000 });
  });
});

describe('buying hosting + domain together still auto-creates the site', () => {
  it('creates the site on settlement and records the domain paid period', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'pkg-ca-2', display_name: 'Cả Hai', domain_interval: 'yearly' } }, buyerB.cookie);
    expect(q.statusCode, q.body).toBe(201);
    // 499000 hosting (monthly) + 100000 domain (yearly) in ONE total.
    expect(q.json().data.total_minor).toBe('599000');
    await settleOrder(buyerB.cookie, q.json().data.id, 599000);
    const site = await ctx.db.query<{ days: number }>(
      "SELECT EXTRACT(EPOCH FROM (domain_paid_until - now())) / 86400 AS days FROM sites WHERE subdomain = 'pkg-ca-2'",
    );
    expect(site.rows.length).toBe(1);
    expect(Number(site.rows[0]!.days)).toBeGreaterThan(300);
  });
});

describe('installation package: separate, opt-in, owner-priced', () => {
  it('cannot be added while the owner has not enabled/priced it', async () => {
    await ctx.db.query("DELETE FROM settings WHERE key = 'service.installation'");
    const q = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, installation: true }, buyerA.cookie);
    expect(q.statusCode).toBe(422);
  });

  it('adds its own line and creates a staff service task on settlement', async () => {
    await setSetting('service.installation', { enabled: true, amount_minor: 300000 });
    const q = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, installation: true }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data.total_minor).toBe('499999');
    expect(q.json().data.installation).toBe(true);
    const orderId = await settleOrder(buyerA.cookie, q.json().data.id, 499999);
    const tasks = await ctx.db.query<{ status: string }>("SELECT status FROM service_tasks WHERE order_id = $1 AND kind = 'installation'", [orderId]);
    expect(tasks.rows[0]?.status).toBe('pending');
    const queue = await get('/api/v1/admin/service-tasks', ownerCookie);
    expect(queue.statusCode, queue.body).toBe(200);
    const mine = (queue.json().data as { order_id: string; id: string }[]).find((t) => t.order_id === orderId);
    expect(mine).toBeTruthy();
    const done = await post(`/api/v1/admin/service-tasks/${mine!.id}/complete`, {}, ownerCookie);
    expect(done.statusCode, done.body).toBe(200);
    const order = await get(`/api/v1/orders/${orderId}`, buyerA.cookie);
    expect(order.json().data.installation_status).toBe('done');
  });
});

describe('standalone hosting upgrade + standalone domain package', () => {
  let selfEntitlementId: string;
  let siteId: string;

  it('lets an owner of the web buy hosting on its own', async () => {
    const q = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId }, buyerA.cookie);
    await settleOrder(buyerA.cookie, q.json().data.id, 199999);
    const ents = await get('/api/v1/me/entitlements', buyerA.cookie);
    const self = (ents.json().data as { id: string; mode: string }[]).find((e) => e.mode === 'selfhost');
    expect(self).toBeTruthy();
    selfEntitlementId = self!.id;

    const foreign = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, upgrade_entitlement_id: selfEntitlementId }, buyerB.cookie);
    expect(foreign.statusCode).toBe(422);
    const wrongPlan = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, upgrade_entitlement_id: selfEntitlementId }, buyerA.cookie);
    expect(wrongPlan.statusCode).toBe(422);
    const up = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, upgrade_entitlement_id: selfEntitlementId }, buyerA.cookie);
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().data.upgrade_entitlement_id).toBe(selfEntitlementId);
  });

  it('sells the domain on its own for an existing site and extends its paid period', async () => {
    // Buyer A turns the upgrade into a real hosted entitlement + site.
    const up = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, upgrade_entitlement_id: selfEntitlementId }, buyerA.cookie);
    await settleOrder(buyerA.cookie, up.json().data.id, 499000);
    const ents = await get('/api/v1/me/entitlements', buyerA.cookie);
    const hosted = (ents.json().data as { id: string; mode: string }[]).find((e) => e.mode === 'hosted');
    expect(hosted).toBeTruthy();
    const created = await post('/api/v1/sites', { entitlement_id: hosted!.id, display_name: 'Web Riêng', subdomain: 'pkg-rieng-1', default_locale: 'vi' }, buyerA.cookie);
    expect(created.statusCode, created.body).toBe(201);
    siteId = created.json().data.id as string;

    const foreign = await post('/api/v1/quotes/domain-package', { site_id: siteId }, buyerB.cookie);
    expect(foreign.statusCode).toBe(404);

    const dq = await post('/api/v1/quotes/domain-package', { site_id: siteId }, buyerA.cookie);
    expect(dq.statusCode, dq.body).toBe(201);
    expect(dq.json().data.total_minor).toBe('10000');
    await settleOrder(buyerA.cookie, dq.json().data.id, 10000);
    const afterMonthly = await ctx.db.query<{ days: number }>(
      'SELECT EXTRACT(EPOCH FROM (domain_paid_until - now())) / 86400 AS days FROM sites WHERE id = $1',
      [siteId],
    );
    expect(Number(afterMonthly.rows[0]!.days)).toBeGreaterThan(25);

    const yq = await post('/api/v1/quotes/domain-package', { site_id: siteId, domain_interval: 'yearly' }, buyerA.cookie);
    expect(yq.statusCode, yq.body).toBe(201);
    expect(yq.json().data.total_minor).toBe('100000');
    await settleOrder(buyerA.cookie, yq.json().data.id, 100000);
    const afterYearly = await ctx.db.query<{ days: number }>(
      'SELECT EXTRACT(EPOCH FROM (domain_paid_until - now())) / 86400 AS days FROM sites WHERE id = $1',
      [siteId],
    );
    expect(Number(afterYearly.rows[0]!.days)).toBeGreaterThan(380);
  });

  it('hands the one-time admin setup token only to the dynamic site owner', async () => {
    const dynVersion = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.1.0', 1, '{"capabilities":["admin"]}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
      [templateId, 'e'.repeat(64), (await ctx.db.query<{ id: string }>("SELECT id FROM artifacts LIMIT 1")).rows[0]!.id],
    );
    const dynSite = await ctx.db.query<{ id: string }>(
      `INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status)
       VALUES ($1, $2, 'Web Động', 'pkg-dong-1', 'active') RETURNING id`,
      [buyerA.id, dynVersion.rows[0]!.id],
    );
    const dynSiteId = dynSite.rows[0]!.id;
    const dataDir = join(ctx.config.workDir, 'sites', dynSiteId, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'setup-token.txt'), 'tok-secret-123', 'utf8');

    const mine = await get(`/api/v1/sites/${dynSiteId}/admin-setup`, buyerA.cookie);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data.setup_pending).toBe(true);
    expect(mine.json().data.token).toBe('tok-secret-123');
    expect(mine.json().data.setup_url).toContain('/admin/setup');
    const foreign = await get(`/api/v1/sites/${dynSiteId}/admin-setup`, buyerB.cookie);
    expect(foreign.statusCode).toBe(404);
    const staticSite = await get(`/api/v1/sites/${siteId}/admin-setup`, buyerA.cookie);
    expect(staticSite.statusCode).toBe(409);
  });
});

describe('storage-priced hosting: owner rate per GB x GB bought', () => {
  it('multiplies the owner rate by the chosen GB for both periods', async () => {
    await setSetting('hosting.storage_price', { monthly_per_gb: 50000, yearly_per_gb: 500000 });
    const m = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, storage_gb: 3 }, buyerB.cookie);
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json().data.total_minor).toBe('150000');
    expect(m.json().data.storage_gb).toBe(3);
    const lines = m.json().data.line_items as { label: string; amount_minor: string }[];
    expect(lines.some((l) => l.label.endsWith(':first_period') && l.amount_minor === '150000')).toBe(true);
    const y = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, billing_interval: 'yearly', storage_gb: 2 }, buyerB.cookie);
    expect(y.statusCode, y.body).toBe(201);
    expect(y.json().data.total_minor).toBe('1000000');
  });

  it('records the bought GB on the entitlement at settlement', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, storage_gb: 4 }, buyerB.cookie);
    await settleOrder(buyerB.cookie, q.json().data.id, 200000);
    const ent = await ctx.db.query<{ storage_gb: number }>(
      'SELECT storage_gb FROM entitlements WHERE user_id = $1 AND mode = \'hosted\' ORDER BY created_at DESC LIMIT 1',
      [buyerB.id],
    );
    expect(ent.rows[0]?.storage_gb).toBe(4);
  });

  it('refuses extra GB without an owner rate, and storage on self-host', async () => {
    await ctx.db.query("DELETE FROM settings WHERE key = 'hosting.storage_price'");
    const noRate = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, storage_gb: 2 }, buyerB.cookie);
    expect(noRate.statusCode).toBe(422);
    const flat = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId }, buyerB.cookie);
    expect(flat.statusCode, flat.body).toBe(201);
    expect(flat.json().data.total_minor).toBe('499000');
    const self = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, storage_gb: 2 }, buyerB.cookie);
    expect(self.statusCode).toBe(422);
  });
});
