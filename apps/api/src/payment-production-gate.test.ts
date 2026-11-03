import { randomUUID } from 'node:crypto';
import { hashPassword } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, sessionCookie, type TestContext } from './test-helpers.ts';

/** Production gate for the sandbox payment provider (go-live hardening):
 *  in production the mock provider is ENTIRELY unavailable (audit
 *  payments L1, wave 3) — no account, whatever roles it holds, can create
 *  or settle a mock payment or refund. No real method configured means
 *  "not payable yet", never a free checkout, not even for staff. */
const PROD_ORIGIN = 'https://webmaket.com';
let ctx: TestContext;
let ownerCookie: string;
let supportCookie: string;
let buyerCookie: string;
let templateId: string;
let planId: string;
const TERMS = 'terms-2026-10';

/** createUser logs in against the dev origin; the production context only
 *  accepts its own portal origin, so mirror the helper with PROD_ORIGIN. */
async function prodUser(email: string, role?: string): Promise<{ id: string; cookie: string }> {
  const password = 'correct horse battery staple';
  const { rows } = await ctx.db.query<{ id: string }>(
    "INSERT INTO users (email_normalized, display_name, password_hash, verified_at) VALUES ($1, 'Test', $2, now()) RETURNING id",
    [email, await hashPassword(password, 1024)],
  );
  const id = rows[0]!.id;
  if (role) await ctx.db.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [id, role]);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: PROD_ORIGIN }, payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return { id, cookie: sessionCookie(res) };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: 'production',
    portalOrigin: PROD_ORIGIN,
    previewOriginTemplate: 'https://{label}.preview.webmaket.com',
    previewBaseDomain: 'preview.webmaket.com',
    siteBaseDomain: 'webmaket.com',
    siteOriginTemplate: 'https://{label}.webmaket.com',
    mockPaymentSecret: 'prod-test-mock-secret',
    partnerLinkSecret: 'prod-test-link-secret',
    partnerWebhookKey: 'prod-test-webhook-key',
    mfaKey: 'prod-test-mfa-key',
    cookieSecure: true,
  });
  const owner = await prodUser('prod-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  const support = await prodUser('prod-support@example.com', 'support');
  supportCookie = support.cookie;
  const buyer = await prodUser('prod-buyer@example.com');
  buyerCookie = buyer.cookie;

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('prod-gate-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu prod', 'prod-gate-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/prod-gate-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['e'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'e'.repeat(64), artifact.rows[0]!.id],
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

const post = (url: string, payload: unknown, cookie?: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: PROD_ORIGIN, ...(cookie ? { cookie } : {}) } });
const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: PROD_ORIGIN, cookie } });

async function newOrder(cookie: string): Promise<string> {
  const q = await post('/api/v1/quotes', { plan_id: planId, template_id: templateId }, cookie);
  expect(q.statusCode, q.body).toBe(201);
  const o = await ctx.app.inject({
    method: 'POST', url: '/api/v1/orders',
    payload: { quote_id: q.json().data.id, terms_version: TERMS },
    headers: { origin: PROD_ORIGIN, cookie, 'idempotency-key': randomUUID() },
  });
  expect(o.statusCode, o.body).toBe(201);
  return o.json().data.id as string;
}

describe('sandbox payments in production', () => {
  it('refuses a plain buyer a mock session (no free checkout)', async () => {
    const orderId = await newOrder(buyerCookie);
    const res = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, buyerCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('payment.method_unavailable');
    const named = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'mock' }, buyerCookie);
    expect(named.statusCode).toBe(409);
  });

  it('refuses a role-holding staff account (owner) a mock session in production', async () => {
    const orderId = await newOrder(ownerCookie);
    const session = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, ownerCookie);
    expect(session.statusCode, session.body).toBe(409);
    expect(session.json().error.code).toBe('payment.method_unavailable');
    const named = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'mock' }, ownerCookie);
    expect(named.statusCode).toBe(409);
    expect((await get(`/api/v1/orders/${orderId}`, ownerCookie)).json().data.payment_status).toBe('awaiting_payment');
  });

  it('refuses a limited-role account (support) a mock session in production', async () => {
    const orderId = await newOrder(supportCookie);
    const session = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, supportCookie);
    expect(session.statusCode, session.body).toBe(409);
    expect(session.json().error.code).toBe('payment.method_unavailable');
    const named = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'mock' }, supportCookie);
    expect(named.statusCode).toBe(409);
  });

  it('mock confirm/settle and mock refund endpoints are gone in production for every role', async () => {
    const ref = 'mockpay_00000000-0000-0000-0000-000000000000';
    for (const cookie of [ownerCookie, supportCookie, buyerCookie, undefined]) {
      const confirm = await post(`/api/v1/payments/mock/${ref}/confirm`, {}, cookie);
      expect(confirm.statusCode).toBe(404);
      const refundOk = await post('/api/v1/payments/mock/refunds/mockrefund_x/confirm', {}, cookie);
      expect(refundOk.statusCode).toBe(404);
      const refundFail = await post('/api/v1/payments/mock/refunds/mockrefund_x/fail', {}, cookie);
      expect(refundFail.statusCode).toBe(404);
    }
  });

  it('mock payment and refund webhooks are gone in production', async () => {
    const hook = await post('/api/v1/payments/webhooks/mock', {}, ownerCookie);
    expect(hook.statusCode).toBe(404);
    const refundHook = await post('/api/v1/payments/refund-webhooks/mock', {}, ownerCookie);
    expect(refundHook.statusCode).toBe(404);
  });
});
