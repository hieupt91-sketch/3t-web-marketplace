import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@3t/core';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Static + hosting rule and the one-time setup (owner model 2026-11-03):
 *  a static template has no admin, so platform hosting is sold for it
 *  ONLY together with the installation package — the paid one-time
 *  setup. The buyer then fills their business info exactly once on the
 *  order (the form never expires; the submission is the only lock) and
 *  staff bake it in from the service-task queue. Without the setup, the
 *  buyer is steered to the dynamic twin. Partner sales have no setup
 *  option, so hosted static is refused there outright. */
let ctx: TestContext;
let ownerCookie: string;
let buyerA: { id: string; cookie: string };
let buyerB: { id: string; cookie: string };
let staticId: string;
let staticHostedPlanId: string;
let staticSelfhostPlanId: string;
let twinId: string;
let twinHostedPlanId: string;
let lonelyId: string;
let lonelyHostedPlanId: string;
let partnerKey: string;
const TERMS = 'terms-2026-10';
const HUB_KEY = 'static-setup-hub-key';

const get = (url: string, cookie?: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });
const partnerApi = (method: string, url: string, payload?: unknown) =>
  ctx.app.inject({ method: method as 'POST', url, payload: payload as object | undefined, headers: { origin: ORIGIN, authorization: `Bearer ${partnerKey}` } });

async function setSetting(key: string, value: unknown): Promise<void> {
  await ctx.db.query(
    `INSERT INTO settings (key, value_json) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    [key, JSON.stringify(value)],
  );
}

async function makeTemplate(slug: string, adapter: string): Promise<string> {
  const owner = await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE email_normalized = 'ss-owner@example.com'");
  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [slug, owner.rows[0]!.id],
  );
  const id = tpl.rows[0]!.id;
  await ctx.db.query(
    'INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, \'vi\', $2, $3, \'published\')',
    [id, `Mẫu ${slug}`, slug],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    [`test/${slug}`, randomBytes(32).toString('hex')],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, $5::jsonb, $2, $3, $4, $4, 'published') RETURNING id`,
    [id, adapter, randomBytes(32).toString('hex'), artifact.rows[0]!.id, JSON.stringify({ adapter })],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [id, version.rows[0]!.id]);
  return id;
}

async function makePlan(templateId: string, code: string, mode: 'hosted' | 'selfhost', amount: number): Promise<string> {
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, $2, $3, '{"vi":"Gói","en":"Plan"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId, code, mode],
  );
  await ctx.db.query(
    'INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, \'VND\', $2, $3, now() - interval \'1 day\')',
    [plan.rows[0]!.id, amount, mode === 'hosted' ? 'monthly' : 'one_time'],
  );
  return plan.rows[0]!.id;
}

async function settle(cookie: string, quoteId: string, amount: number): Promise<string> {
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
  const owner = await createUser(ctx, 'ss-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie);
  buyerA = await createUser(ctx, 'ss-a@example.com');
  buyerB = await createUser(ctx, 'ss-b@example.com');

  staticId = await makeTemplate('static-setup-1', 'static-html');
  staticHostedPlanId = await makePlan(staticId, 'hosted', 'hosted', 499000);
  staticSelfhostPlanId = await makePlan(staticId, 'selfhost', 'selfhost', 199999);
  twinId = await makeTemplate('static-setup-1-dong', 'node-http');
  twinHostedPlanId = await makePlan(twinId, 'hosted', 'hosted', 499000);
  lonelyId = await makeTemplate('static-lonely-1', 'vite-static');
  lonelyHostedPlanId = await makePlan(lonelyId, 'hosted', 'hosted', 499000);

  await setSetting('service.installation', { enabled: true, amount_minor: 300000 });
  const bank = await post('/api/v1/admin/settings/payment', {
    enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
    account_number: '0123456789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
  }, ownerCookie);
  expect(bank.statusCode, bank.body).toBe(200);

  const partnerUser = await createUser(ctx, 'ss-partner@example.com');
  const policy = await ctx.db.query<{ id: string }>("SELECT id FROM partner_policies WHERE code = 'default'");
  const pa = await ctx.db.query<{ id: string }>(
    `INSERT INTO partner_accounts (user_id, code, display_name, status, policy_id, terms_version)
     VALUES ($1, 'p_statictest', 'Static Partner', 'active', $2, 'terms-2026-10') RETURNING id`,
    [partnerUser.id, policy.rows[0]!.id],
  );
  partnerKey = `pk_${randomBytes(18).toString('hex')}`;
  await ctx.db.query(
    'INSERT INTO partner_api_keys (partner_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)',
    [pa.rows[0]!.id, partnerKey.slice(0, 12), hashToken(partnerKey).toString('hex'), ['catalog:read', 'checkout:create', 'wallet:sale']],
  );
});
afterAll(async () => ctx.close());

describe('template detail exposes the dynamic twin', () => {
  it('returns the twin slug for a static template and null for dynamic / twinless ones', async () => {
    const s = await get('/api/v1/templates/static-setup-1');
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().data.dynamic_twin_slug).toBe('static-setup-1-dong');
    const d = await get('/api/v1/templates/static-setup-1-dong');
    expect(d.json().data.dynamic_twin_slug).toBeNull();
    const l = await get('/api/v1/templates/static-lonely-1');
    expect(l.json().data.dynamic_twin_slug).toBeNull();
  });
});

describe('the static + hosting guard in POST /quotes', () => {
  it('refuses hosted for a static template without the one-time setup, carrying the twin in details', async () => {
    const q = await post('/api/v1/quotes', { plan_id: staticHostedPlanId, template_id: staticId }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(409);
    expect(q.json().error.code).toBe('template.static_not_hosted');
    expect(q.json().error.details).toEqual({ dynamic_twin_slug: 'static-setup-1-dong', dynamic_twin_template_id: twinId });
  });

  it('carries null twin details when the static template has no published twin', async () => {
    const q = await post('/api/v1/quotes', { plan_id: lonelyHostedPlanId, template_id: lonelyId }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(409);
    expect(q.json().error.code).toBe('template.static_not_hosted');
    expect(q.json().error.details).toEqual({ dynamic_twin_slug: null, dynamic_twin_template_id: null });
  });

  it('allows hosted for a static template WITH the one-time setup', async () => {
    const q = await post('/api/v1/quotes', { plan_id: staticHostedPlanId, template_id: staticId, installation: true }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data.installation).toBe(true);
    expect(q.json().data.total_minor).toBe('799000');
  });

  it('allows static self-host with or without the setup, and dynamic hosted without it', async () => {
    const plain = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId }, buyerA.cookie);
    expect(plain.statusCode, plain.body).toBe(201);
    const withSetup = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId, installation: true }, buyerA.cookie);
    expect(withSetup.statusCode, withSetup.body).toBe(201);
    const dyn = await post('/api/v1/quotes', { plan_id: twinHostedPlanId, template_id: twinId }, buyerA.cookie);
    expect(dyn.statusCode, dyn.body).toBe(201);
  });

  it('still refuses the setup itself while the owner has not enabled it (validation precedes the guard)', async () => {
    await ctx.db.query("DELETE FROM settings WHERE key = 'service.installation'");
    const q = await post('/api/v1/quotes', { plan_id: staticHostedPlanId, template_id: staticId, installation: true }, buyerA.cookie);
    expect(q.statusCode).toBe(422);
    await setSetting('service.installation', { enabled: true, amount_minor: 300000 });
  });

  it('covers the standalone-hosting upgrade path the same way', async () => {
    const q = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId }, buyerA.cookie);
    const orderId = await settle(buyerA.cookie, q.json().data.id, 199999);
    expect(orderId).toBeTruthy();
    const ents = await get('/api/v1/me/entitlements', buyerA.cookie);
    const self = (ents.json().data as { id: string; mode: string; template: { id: string } }[]).find((e) => e.mode === 'selfhost' && e.template.id === staticId);
    expect(self).toBeTruthy();
    const noSetup = await post('/api/v1/quotes', { plan_id: staticHostedPlanId, template_id: staticId, upgrade_entitlement_id: self!.id }, buyerA.cookie);
    expect(noSetup.statusCode, noSetup.body).toBe(409);
    expect(noSetup.json().error.code).toBe('template.static_not_hosted');
    const withSetup = await post('/api/v1/quotes', { plan_id: staticHostedPlanId, template_id: staticId, upgrade_entitlement_id: self!.id, installation: true }, buyerA.cookie);
    expect(withSetup.statusCode, withSetup.body).toBe(201);
  });
});

describe('one-time setup info on the order', () => {
  let orderId: string;

  beforeAll(async () => {
    const q = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId, installation: true }, buyerA.cookie);
    expect(q.statusCode, q.body).toBe(201);
    orderId = await settle(buyerA.cookie, q.json().data.id, 499999);
  });

  it('exposes an unsubmitted setup_info on the buyer order payload', async () => {
    const o = await get(`/api/v1/orders/${orderId}`, buyerA.cookie);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().data.installation_status).toBe('pending');
    expect(o.json().data.setup_info).toEqual({ submitted: false, submitted_at: null, data: null });
  });

  it('accepts the single submission and locks it', async () => {
    const payload = {
      business_name: 'Phụ Tùng Ô Tô Minh Phát',
      phone: '0901234567',
      email: 'lienhe@minhphat.example',
      address: '12 Lê Lợi, Quận 1, TP.HCM',
      about: 'Chuyên phụ tùng ô tô chính hãng.',
      facebook_url: 'https://facebook.com/minhphat',
      zalo: '0901234567',
      google_sheet_url: 'https://script.google.com/macros/s/AKfycTEST/exec',
      note: 'Nhờ gọi trước khi giao',
      seo_title: 'Phụ Tùng Ô Tô Minh Phát — Chính hãng, giá tốt tại TP.HCM',
      seo_description: 'Minh Phát chuyên phụ tùng ô tô chính hãng tại Quận 1, TP.HCM. Báo giá nhanh qua Zalo.',
      logo_url: '',
    };
    const res = await post(`/api/v1/orders/${orderId}/setup-info`, payload, buyerA.cookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.submitted).toBe(true);
    expect(res.json().data.data.business_name).toBe('Phụ Tùng Ô Tô Minh Phát');
    expect(res.json().data.data.google_sheet_url).toContain('/exec');
    expect(res.json().data.data.seo_title).toContain('Minh Phát');
    expect(res.json().data.data.seo_description).toContain('chính hãng');
    expect(res.json().data.data.logo_url).toBeUndefined(); // empty values are dropped

    const o = await get(`/api/v1/orders/${orderId}`, buyerA.cookie);
    expect(o.json().data.setup_info.submitted).toBe(true);
    expect(o.json().data.setup_info.data.business_name).toBe('Phụ Tùng Ô Tô Minh Phát');
    expect(o.json().data.setup_info.data.seo_title).toContain('Minh Phát');

    const again = await post(`/api/v1/orders/${orderId}/setup-info`, { business_name: 'Tên Khác' }, buyerA.cookie);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('setup_info.already_submitted');
  });

  it('shows the submitted info to staff on the service-task queue', async () => {
    const queue = await get('/api/v1/admin/service-tasks?status=pending', ownerCookie);
    expect(queue.statusCode, queue.body).toBe(200);
    const mine = (queue.json().data as { order_id: string; setup_info_json: { business_name: string; google_sheet_url: string; seo_title?: string } | null; setup_info_submitted_at: string | null }[])
      .find((t) => t.order_id === orderId);
    expect(mine).toBeTruthy();
    expect(mine!.setup_info_json?.business_name).toBe('Phụ Tùng Ô Tô Minh Phát');
    expect(mine!.setup_info_json?.google_sheet_url).toContain('/exec');
    expect(mine!.setup_info_json?.seo_title).toContain('Minh Phát');
    expect(mine!.setup_info_submitted_at).toBeTruthy();
  });

  it('never expires: an order from long ago with an unsubmitted task still accepts the form', async () => {
    const q = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId, installation: true }, buyerB.cookie);
    const oldOrderId = await settle(buyerB.cookie, q.json().data.id, 499999);
    await ctx.db.query("UPDATE orders SET created_at = now() - interval '2 years', paid_at = now() - interval '2 years' WHERE id = $1", [oldOrderId]);
    await ctx.db.query("UPDATE service_tasks SET created_at = now() - interval '2 years' WHERE order_id = $1", [oldOrderId]);
    const o = await get(`/api/v1/orders/${oldOrderId}`, buyerB.cookie);
    expect(o.json().data.setup_info).toEqual({ submitted: false, submitted_at: null, data: null });
    const res = await post(`/api/v1/orders/${oldOrderId}/setup-info`, { business_name: 'Cửa Hàng Cũ Vẫn Gửi Được' }, buyerB.cookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.submitted).toBe(true);
  });

  it('is not applicable to dynamic orders or orders without the package, and hides from other buyers', async () => {
    const dq = await post('/api/v1/quotes', { plan_id: twinHostedPlanId, template_id: twinId, installation: true }, buyerA.cookie);
    expect(dq.statusCode, dq.body).toBe(201);
    const dynOrderId = await settle(buyerA.cookie, dq.json().data.id, 799000);
    const dynOrder = await get(`/api/v1/orders/${dynOrderId}`, buyerA.cookie);
    expect(dynOrder.json().data.installation_status).toBe('pending');
    expect(dynOrder.json().data.setup_info).toBeNull();
    const dynPost = await post(`/api/v1/orders/${dynOrderId}/setup-info`, { business_name: 'Không Áp Dụng' }, buyerA.cookie);
    expect(dynPost.statusCode).toBe(404);

    const pq = await post('/api/v1/quotes', { plan_id: staticSelfhostPlanId, template_id: staticId }, buyerB.cookie);
    const plainOrderId = await settle(buyerB.cookie, pq.json().data.id, 199999);
    const plainPost = await post(`/api/v1/orders/${plainOrderId}/setup-info`, { business_name: 'Không Có Gói' }, buyerB.cookie);
    expect(plainPost.statusCode).toBe(404);

    const foreign = await post(`/api/v1/orders/${orderId}/setup-info`, { business_name: 'Người Lạ' }, buyerB.cookie);
    expect(foreign.statusCode).toBe(404);
  });
});

describe('partner paths refuse hosted static (no setup option there)', () => {
  it('partner quotes: hosted static → 409 with the twin; self-host static → 201', async () => {
    const hosted = await partnerApi('POST', '/api/v1/partner/v1/quotes', { template_id: staticId, plan_id: staticHostedPlanId });
    expect(hosted.statusCode, hosted.body).toBe(409);
    expect(hosted.json().error.code).toBe('template.static_not_hosted');
    expect(hosted.json().error.details.dynamic_twin_slug).toBe('static-setup-1-dong');
    const self = await partnerApi('POST', '/api/v1/partner/v1/quotes', { template_id: staticId, plan_id: staticSelfhostPlanId });
    expect(self.statusCode, self.body).toBe(201);
  });

  it('partner wallet-sales: hosted static → 409 and nothing is sold', async () => {
    const sale = await partnerApi('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: staticId, plan_id: staticHostedPlanId, buyer_email: 'ss-a@example.com', external_reference: 'ss-static-hosted-1',
    });
    expect(sale.statusCode, sale.body).toBe(409);
    expect(sale.json().error.code).toBe('template.static_not_hosted');
    const rows = await ctx.db.query("SELECT 1 FROM partner_wallet_sales WHERE external_reference = 'ss-static-hosted-1'");
    expect(rows.rows.length).toBe(0);
  });
});
