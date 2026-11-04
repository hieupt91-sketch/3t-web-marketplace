import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Hosted checkout with the domain chosen while buying (owner rule
 *  2026-11-01): quote holds the name, the subdomain fee joins the same
 *  total, and fulfilment creates the site so the buyer just logs in and
 *  it runs. Installation support stays a separate service (not bundled). */
let ctx: TestContext;
let ownerCookie: string;
let buyerA: { id: string; cookie: string };
let buyerB: { id: string; cookie: string };
let templateId: string;
let hostedPlanId: string;
let selfhostPlanId: string;
const TERMS = 'terms-2026-10';
const HUB_KEY = 'hosted-hub-key-1';

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });

async function buyAndSettle(cookie: string, quoteId: string, amount: number): Promise<string> {
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

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'hosted-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // wave-1: payment settings + manual confirm require step-up
  buyerA = await createUser(ctx, 'hosted-a@example.com');
  buyerB = await createUser(ctx, 'hosted-b@example.com');

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('hosted-checkout-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu hosted', 'hosted-checkout-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/hosted-checkout-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['c'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'c'.repeat(64), artifact.rows[0]!.id],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [templateId, version.rows[0]!.id]);
  const hosted = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'hosted', 'hosted', '{"vi":"Gói Hosting","en":"Hosting"}'::jsonb, '{"instance_limit":2}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  hostedPlanId = hosted.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 499000, 'monthly', now() - interval '1 day')",
    [hostedPlanId],
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

describe('hosted checkout with domain chosen at purchase', () => {
  it('rejects a site request on a self-host plan and bad names', async () => {
    const self = await post('/api/v1/quotes', { plan_id: selfhostPlanId, template_id: templateId, site_request: { subdomain: 'cafe-self', display_name: 'Cafe' } }, buyerA.cookie);
    expect(self.statusCode).toBe(422);
    const reserved = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'www', display_name: 'Cafe' } }, buyerA.cookie);
    expect(reserved.statusCode).toBe(422);
  });

  it('holds the chosen name for the buyer and blocks other buyers', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'cafe-mua-1', display_name: 'Cafe Một' } }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data.site_request).toMatchObject({ subdomain: 'cafe-mua-1', display_name: 'Cafe Một' });
    expect(q.json().data.total_minor).toBe('499000');
    const holds = await get('/api/v1/sites/subdomain-reservations', buyerA.cookie);
    expect((holds.json().data as { subdomain: string }[]).map((h) => h.subdomain)).toContain('cafe-mua-1');
    const other = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'cafe-mua-1', display_name: 'Cafe Khác' } }, buyerB.cookie);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('site.subdomain_held');
  });

  it('adds the owner-set subdomain fee into the same total', async () => {
    await ctx.db.query(
      `INSERT INTO settings (key, value_json) VALUES ('subdomain.fee', '{"amount_minor":50000,"period":"once"}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    );
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'cafe-mua-2', display_name: 'Cafe Hai' } }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data.total_minor).toBe('549000');
    const lines = q.json().data.line_items as { label: string; amount_minor: string }[];
    expect(lines.some((l) => l.label === 'subdomain_fee' && l.amount_minor === '50000')).toBe(true);
  });

  it('creates the site automatically when the order is paid — buyer just logs in and it runs', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'cafe-mua-2', display_name: 'Cafe Hai' } }, buyerA.cookie);
    const o = await post('/api/v1/orders', { quote_id: q.json().data.id, terms_version: TERMS }, buyerA.cookie, { 'idempotency-key': randomUUID() });
    expect(o.statusCode, o.body).toBe(201);
    const orderId = o.json().data.id as string;
    // Placing the order stretched the buyer's hold on the name to ~24h, so
    // a slow (overnight) manual settlement cannot lose it.
    const stretched = await ctx.db.query<{ hrs: number }>(
      "SELECT EXTRACT(EPOCH FROM (expires_at - now())) / 3600 AS hrs FROM subdomain_reservations WHERE subdomain = 'cafe-mua-2' AND status = 'active'",
    );
    expect(Number(stretched.rows[0]!.hrs)).toBeGreaterThan(20);
    const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyerA.cookie);
    expect(s.statusCode, s.body).toBe(201);
    const code = s.json().data.instructions.content_code as string;
    const hook = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 777000111, code, transferType: 'in', transferAmount: 549000 },
    });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(hook.json().outcome).toBe('processed');
    const order = await get(`/api/v1/orders/${orderId}`, buyerA.cookie);
    expect(order.json().data.payment_status).toBe('paid');
    const site = await ctx.db.query<{ subdomain: string; display_name: string; status: string }>(
      'SELECT subdomain, display_name, status FROM sites WHERE owner_id = $1 AND subdomain = $2',
      [buyerA.id, 'cafe-mua-2'],
    );
    expect(site.rows[0]).toMatchObject({ subdomain: 'cafe-mua-2', display_name: 'Cafe Hai' });
    const job = await ctx.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM jobs WHERE type = 'site.provision' AND resource_id = (SELECT id FROM sites WHERE subdomain = 'cafe-mua-2')",
    );
    expect(job.rows[0]!.n).toBe('1');
    const hold = await ctx.db.query<{ status: string }>('SELECT status FROM subdomain_reservations WHERE subdomain = $1', ['cafe-mua-2']);
    expect(hold.rows[0]!.status).toBe('consumed');
  });

  it('still fulfils the purchase when the chosen name was lost meanwhile', async () => {
    const q = await post('/api/v1/quotes', { plan_id: hostedPlanId, template_id: templateId, site_request: { subdomain: 'cafe-mua-3', display_name: 'Cafe Ba' } }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    // Someone else ends up owning the name before A's payment lands, and
    // A's hold is gone: fulfilment must keep the entitlement and skip the
    // auto-create rather than failing the paid order.
    await ctx.db.query("UPDATE subdomain_reservations SET status = 'released' WHERE subdomain = 'cafe-mua-3'");
    const tplB = await ctx.db.query<{ id: string }>(
      "INSERT INTO templates (slug, owner_id, status) VALUES ('hosted-checkout-b', $1, 'published') RETURNING id",
      [buyerB.id],
    );
    const artB = await ctx.db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
       VALUES ('test/hosted-checkout-b', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
      ['d'.repeat(64)],
    );
    const verB = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
      [tplB.rows[0]!.id, 'd'.repeat(64), artB.rows[0]!.id],
    );
    const quoteB = await ctx.db.query<{ id: string }>(
      "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 0, 0, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
      [buyerB.id],
    );
    const orderB = await ctx.db.query<{ id: string }>(
      "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version, paid_at) VALUES ($1, $2, 'paid', 'VND', 0, 0, 'terms-2026-10', now()) RETURNING id",
      [buyerB.id, quoteB.rows[0]!.id],
    );
    const planB = await ctx.db.query<{ id: string }>(
      "INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status) VALUES ($1, 'hosted', 'hosted', '{}'::jsonb, '{\"instance_limit\":2}'::jsonb, 'active') RETURNING id",
      [tplB.rows[0]!.id],
    );
    const itemB = await ctx.db.query<{ id: string }>(
      "INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json) VALUES ($1, $2, $3, $4, 'hosted', 0, '{}'::jsonb) RETURNING id",
      [orderB.rows[0]!.id, tplB.rows[0]!.id, verB.rows[0]!.id, planB.rows[0]!.id],
    );
    const entB = await ctx.db.query<{ id: string }>(
      "INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit) VALUES ($1, $2, $3, $4, 'hosted', 'active', 2) RETURNING id",
      [itemB.rows[0]!.id, buyerB.id, tplB.rows[0]!.id, verB.rows[0]!.id],
    );
    await ctx.db.query(
      'INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, default_locale) VALUES ($1, $2, $3, $4, $5, $6)',
      [buyerB.id, entB.rows[0]!.id, verB.rows[0]!.id, 'Cafe Của B', 'cafe-mua-3', 'vi'],
    );
    const orderId = await buyAndSettle(buyerA.cookie, q.json().data.id, 549000);
    const order = await get(`/api/v1/orders/${orderId}`, buyerA.cookie);
    expect(order.json().data.payment_status).toBe('paid');
    const ents = await ctx.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM entitlements WHERE user_id = $1 AND mode = 'hosted'",
      [buyerA.id],
    );
    expect(Number(ents.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    const aSite = await ctx.db.query("SELECT 1 FROM sites WHERE owner_id = $1 AND subdomain = 'cafe-mua-3'", [buyerA.id]);
    expect(aSite.rows.length).toBe(0);
  });
});
