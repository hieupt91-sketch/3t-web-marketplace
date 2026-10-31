import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** Bank-transfer payments (owner proposal 2026-10-30): owner settings, the
 *  transfer session with content code, hub webhook settlement (SePay shape),
 *  and the staff manual-confirm fallback. */
let ctx: TestContext;
let ownerCookie: string;
let buyerCookie: string;
let buyer2Cookie: string;
let templateId: string;
let planId: string;
const TERMS = 'terms-2026-10';
const HUB_KEY = 'test-hub-key-123';

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'bank-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  const buyer = await createUser(ctx, 'bank-buyer@example.com');
  buyerCookie = buyer.cookie;
  const buyer2 = await createUser(ctx, 'bank-buyer2@example.com');
  buyer2Cookie = buyer2.cookie;

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('bank-pay-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu bank', 'bank-pay-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/bank-pay-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['b'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'b'.repeat(64), artifact.rows[0]!.id],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [templateId, version.rows[0]!.id]);
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'selfhost', 'selfhost', '{"vi":"Gói","en":"Plan"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  planId = plan.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 499000, 'one_time', now() - interval '1 day')",
    [planId],
  );
});
afterAll(async () => ctx.close());

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });

async function newOrder(cookie: string): Promise<string> {
  const q = await post('/api/v1/quotes', { plan_id: planId, template_id: templateId }, cookie);
  expect(q.statusCode, q.body).toBe(201);
  const o = await post('/api/v1/orders', { quote_id: q.json().data.id, terms_version: TERMS }, cookie, { 'idempotency-key': randomUUID() });
  expect(o.statusCode, o.body).toBe(201);
  return o.json().data.id as string;
}

async function enableBank(withHubKey: boolean) {
  const body: Record<string, unknown> = {
    enabled: true,
    bank_name: 'Vietcombank',
    account_number: '0123 456 789',
    account_holder: 'WEBMAKET TEST',
  };
  if (withHubKey) body.hub_api_key = HUB_KEY;
  const res = await post('/api/v1/admin/settings/payment', body, ownerCookie);
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

describe('payment settings (admin)', () => {
  it('requires settings:manage and starts disabled and unconfigured', async () => {
    expect((await get('/api/v1/admin/settings/payment', buyerCookie)).statusCode).toBe(403);
    const res = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: false, hub_configured: false });
    expect(res.json().data.webhook_url).toContain('/api/v1/payments/webhooks/bank_transfer');
  });

  it('rejects enabling without complete bank details', async () => {
    const res = await post('/api/v1/admin/settings/payment', { enabled: true, bank_name: '', account_number: '12', account_holder: '' }, ownerCookie);
    expect(res.statusCode).toBe(422); // errors.validation is 422 platform-wide
  });

  it('saves settings; the hub key is stored but never returned', async () => {
    const res = await enableBank(true);
    expect(res.json().data).toMatchObject({ enabled: true, bank_name: 'Vietcombank', account_number: '0123456789', hub_configured: true });
    expect(res.body).not.toContain(HUB_KEY);
    const again = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(again.json().data.hub_configured).toBe(true);
    expect(again.body).not.toContain(HUB_KEY);
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(pub.json().data.payment.bank_transfer).toBe(true);
  });
});

describe('bank transfer checkout + hub webhook', () => {
  let orderId: string;
  let code: string;

  it('defaults the session to bank transfer with a content code and bank snapshot', async () => {
    orderId = await newOrder(buyerCookie);
    const res = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyerCookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.provider).toBe('bank_transfer');
    expect(res.json().data.sandbox).toBe(false);
    code = res.json().data.instructions.content_code;
    expect(code).toMatch(/^WM[0-9A-F]{10}$/);
    expect(res.json().data.instructions).toMatchObject({ bank_name: 'Vietcombank', account_number: '0123456789', amount_minor: '499000' });
    expect(res.json().data.provider_ref).toBe(code);
  });

  it('rejects a webhook with the wrong hub key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: 'Apikey wrong-key' },
      payload: { id: 7001, code, transferType: 'in', transferAmount: 499000 },
    });
    expect(res.statusCode).toBe(400);
    const order = await get(`/api/v1/orders/${orderId}`, buyerCookie);
    expect(order.json().data.payment_status).toBe('awaiting_payment');
  });

  it('settles the order from an incoming hub report and is idempotent', async () => {
    const payload = { id: 7002, gateway: 'Vietcombank', code, content: `${code} thanh toan don`, transferType: 'in', transferAmount: 499000, referenceCode: 'FT7002' };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/bank_transfer', headers: { authorization: `Apikey ${HUB_KEY}` }, payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('processed');
    const order = await get(`/api/v1/orders/${orderId}`, buyerCookie);
    expect(order.json().data.payment_status).toBe('paid');
    const ents = await get('/api/v1/me/entitlements', buyerCookie);
    expect(ents.json().data.length).toBe(1);
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/bank_transfer', headers: { authorization: `Apikey ${HUB_KEY}` }, payload });
    expect(dup.json().outcome).toBe('duplicate');
    expect((await get('/api/v1/me/entitlements', buyerCookie)).json().data.length).toBe(1);
  });

  it('ignores outgoing reports, then staff confirm manually as the fallback', async () => {
    const order2 = await newOrder(buyer2Cookie);
    const s = await post(`/api/v1/orders/${order2}/payment-sessions`, {}, buyer2Cookie);
    const code2 = s.json().data.instructions.content_code as string;
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 7003, code: code2, transferType: 'out', transferAmount: 499000 },
    });
    expect(out.json().outcome).toBe('ignored');
    expect((await get(`/api/v1/orders/${order2}`, buyer2Cookie)).json().data.payment_status).toBe('awaiting_payment');

    const attempts = await get(`/api/v1/orders/${order2}/payment-attempts`, buyer2Cookie);
    const attemptId = attempts.json().data[0].id as string;
    expect(attempts.json().data[0].instructions.content_code).toBe(code2);
    expect((await post(`/api/v1/admin/payments/attempts/${attemptId}/confirm`, {}, buyer2Cookie)).statusCode).toBe(403);
    const confirm = await post(`/api/v1/admin/payments/attempts/${attemptId}/confirm`, {}, ownerCookie);
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json().data.outcome).toBe('processed');
    expect((await get(`/api/v1/orders/${order2}`, buyer2Cookie)).json().data.payment_status).toBe('paid');
    // A settled attempt cannot be confirmed twice.
    expect((await post(`/api/v1/admin/payments/attempts/${attemptId}/confirm`, {}, ownerCookie)).statusCode).toBe(409);
  });

  it('routes a wrong-amount hub report to reconciliation instead of fulfilling', async () => {
    const order3 = await newOrder(buyer2Cookie);
    const s = await post(`/api/v1/orders/${order3}/payment-sessions`, {}, buyer2Cookie);
    const code3 = s.json().data.instructions.content_code as string;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 7004, code: code3, transferType: 'in', transferAmount: 400000 },
    });
    expect(res.json().outcome).toBe('needs_reconciliation');
    expect((await get(`/api/v1/orders/${order3}`, buyer2Cookie)).json().data.payment_status).toBe('needs_reconciliation');
  });

  it('falls back to the sandbox mock once bank transfer is disabled', async () => {
    const off = await post('/api/v1/admin/settings/payment', { enabled: false, bank_name: 'Vietcombank', account_number: '0123456789', account_holder: 'WEBMAKET TEST' }, ownerCookie);
    expect(off.statusCode).toBe(200);
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(pub.json().data.payment.bank_transfer).toBe(false);
    const order4 = await newOrder(buyerCookie);
    const s = await post(`/api/v1/orders/${order4}/payment-sessions`, {}, buyerCookie);
    expect(s.json().data.provider).toBe('mock');
    const named = await post(`/api/v1/orders/${order4}/payment-sessions`, { provider: 'bank_transfer' }, buyerCookie);
    expect(named.statusCode).toBe(409);
    const bogus = await post(`/api/v1/orders/${order4}/payment-sessions`, { provider: 'carrier_pigeon' }, buyerCookie);
    expect(bogus.statusCode).toBe(409);
  });
});

describe('casso hub webhook', () => {
  beforeAll(async () => {
    await enableBank(true);
  });

  const cassoPost = (payload: unknown, token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/casso', headers: { 'secure-token': token }, payload: payload as object });

  it('rejects a wrong secure token and leaves the order unpaid', async () => {
    const orderId = await newOrder(buyerCookie);
    const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyerCookie);
    const code = s.json().data.instructions.content_code as string;
    const res = await cassoPost({ error: 0, data: [{ id: 88001, description: `${code} thanh toan`, amount: 499000 }] }, 'wrong-token');
    expect(res.statusCode).toBe(401);
    expect(res.json().success).toBe(false);
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('awaiting_payment');
  });

  it('settles the order from a Casso batch, ignores unrelated transactions, and is idempotent', async () => {
    const orderId = await newOrder(buyerCookie);
    const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyerCookie);
    const code = s.json().data.instructions.content_code as string;
    const payload = {
      error: 0,
      data: [
        { id: 88002, tid: 'FT88002', description: `${code} thanh toan don hang`, amount: 499000, cusum_balance: 9000000, when: '2026-10-31 10:00:00', bank_sub_acc_id: '0123456789' },
        { id: 88003, tid: 'FT88003', description: 'chuyen khoan thuong khong ma', amount: 50000, when: '2026-10-31 10:01:00' },
      ],
    };
    const res = await cassoPost(payload, HUB_KEY);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().outcomes).toEqual(['processed', 'ignored']);
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
    expect((await get('/api/v1/me/entitlements', buyerCookie)).json().data.length).toBeGreaterThan(0);
    const before = (await get('/api/v1/me/entitlements', buyerCookie)).json().data.length;
    const dup = await cassoPost(payload, HUB_KEY);
    expect(dup.json().outcomes).toEqual(['duplicate', 'duplicate']);
    expect((await get('/api/v1/me/entitlements', buyerCookie)).json().data.length).toBe(before);
  });

  it('routes a wrong-amount Casso transaction to reconciliation instead of fulfilling', async () => {
    const orderId = await newOrder(buyer2Cookie);
    const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyer2Cookie);
    const code = s.json().data.instructions.content_code as string;
    const res = await cassoPost({ error: 0, data: [{ id: 88004, description: code, amount: 400000 }] }, HUB_KEY);
    expect(res.json().outcomes).toEqual(['needs_reconciliation']);
    expect((await get(`/api/v1/orders/${orderId}`, buyer2Cookie)).json().data.payment_status).toBe('needs_reconciliation');
  });
});
