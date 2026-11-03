import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@3t/core';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Partner wallet (docs/06 §11): partners top up in advance by bank
 *  transfer, set their own selling prices, and direct API sales deduct
 *  the cost — listed retail minus the policy cut — from the wallet
 *  automatically. The referral commission model is untouched: a wallet
 *  sale earns NO commission on top of the cut. */
let ctx: TestContext;
let ownerCookie: string;
let partnerCookie: string;
let partnerId: string;
let partnerKey: string;
let buyer: { id: string; email: string };
let templateId: string;
let planId: string;
let oddPlanId: string;
const HUB_KEY = 'wallet-hub-key-1';

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });
const put = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'PUT', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });
const api = (method: string, url: string, payload?: unknown) =>
  ctx.app.inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: { origin: ORIGIN, authorization: `Bearer ${partnerKey}` } });

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'wallet-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // wave-1: payment settings + manual confirm require step-up
  const partnerUser = await createUser(ctx, 'wallet-partner@example.com');
  partnerCookie = partnerUser.cookie;
  const b = await createUser(ctx, 'wallet-buyer@example.com');
  buyer = { id: b.id, email: 'wallet-buyer@example.com' };
  await createUser(ctx, 'wallet-buyer2@example.com');
  await createUser(ctx, 'wallet-buyer3@example.com');
  await createUser(ctx, 'wallet-buyer4@example.com');
  await createUser(ctx, 'wallet-buyer5@example.com');

  const policy = await ctx.db.query<{ id: string }>("SELECT id FROM partner_policies WHERE code = 'default'");
  const pa = await ctx.db.query<{ id: string }>(
    `INSERT INTO partner_accounts (user_id, code, display_name, status, policy_id, terms_version)
     VALUES ($1, 'p_wallettest', 'Wallet Partner', 'active', $2, 'terms-2026-10') RETURNING id`,
    [partnerUser.id, policy.rows[0]!.id],
  );
  partnerId = pa.rows[0]!.id;
  partnerKey = `pk_${randomBytes(18).toString('hex')}`;
  await ctx.db.query(
    'INSERT INTO partner_api_keys (partner_id, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4)',
    [partnerId, partnerKey.slice(0, 12), hashToken(partnerKey).toString('hex'), ['catalog:read', 'commissions:read', 'wallet:sale']],
  );

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('wallet-tpl', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu ví', 'wallet-tpl', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/wallet-tpl', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
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
     VALUES ($1, 'selfhost', 'selfhost', '{"vi":"Tự cài","en":"Self-host"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  planId = plan.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 200000, 'one_time', now() - interval '1 day')",
    [planId],
  );
  const odd = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'odd', 'selfhost', '{"vi":"Gói lẻ","en":"Odd"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  oddPlanId = odd.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 199999, 'one_time', now() - interval '1 day')",
    [oddPlanId],
  );
  const bank = await post('/api/v1/admin/settings/payment', {
    enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
    account_number: '0123456789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
  }, ownerCookie);
  expect(bank.statusCode, bank.body).toBe(200);
});
afterAll(async () => ctx.close());

async function walletBalanceViaApi(): Promise<string> {
  const w = await get('/api/v1/partner/wallet', partnerCookie);
  expect(w.statusCode, w.body).toBe(200);
  return w.json().data.balance_points as string;
}

describe('partner wallet', () => {
  it('creates a top-up in points with bank instructions and settles it from the bank webhook', async () => {
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '500' }, partnerCookie);
    expect(t.statusCode, t.body).toBe(201);
    const code = t.json().data.code as string;
    expect(code).toMatch(/^WT[0-9A-F]{10}$/);
    expect(t.json().data.bank.content).toBe(code);
    expect(t.json().data.bank.amount_minor).toBe('500000'); // 500 points x 1,000 VND
    const hook = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 555000111, code, transferType: 'in', transferAmount: 500000 },
    });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(hook.json().outcome).toBe('processed');
    expect(await walletBalanceViaApi()).toBe('500');
    const topup = await ctx.db.query<{ status: string }>('SELECT status FROM partner_topups WHERE code = $1', [code]);
    expect(topup.rows[0]!.status).toBe('paid');
  });

  it('staff can confirm a top-up manually and adjust the wallet with a ledger trail', async () => {
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '100' }, partnerCookie);
    const topupId = t.json().data.id as string;
    const confirm = await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${topupId}/confirm`, {}, ownerCookie);
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json().data.balance_points).toBe('600');
    const again = await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${topupId}/confirm`, {}, ownerCookie);
    expect(again.statusCode).toBe(409);
    const adj = await post(`/api/v1/admin/partners/${partnerId}/wallet/adjust`, { amount_points: '-50', note: 'Đối soát trừ nhầm' }, ownerCookie);
    expect(adj.statusCode, adj.body).toBe(200);
    expect(adj.json().data.balance_points).toBe('550');
    const over = await post(`/api/v1/admin/partners/${partnerId}/wallet/adjust`, { amount_points: '-99999', note: 'Trừ quá số dư' }, ownerCookie);
    expect(over.statusCode).toBe(422);
    expect(await walletBalanceViaApi()).toBe('550');
  });

  it('partner sets their own price; the price list shows listed, cost and own price', async () => {
    const list = await get('/api/v1/partner/prices', partnerCookie);
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().data.plans as { plan_id: string; listed_minor: string; cost_minor: string; cost_points: string }[]).find((p) => p.plan_id === planId)!;
    expect(row.listed_minor).toBe('200000');
    expect(row.cost_minor).toBe('180000'); // default cut 1000 bps = 10%
    expect(row.cost_points).toBe('180');
    const set = await put('/api/v1/partner/prices', { plan_id: planId, amount_points: '250' }, partnerCookie);
    expect(set.statusCode, set.body).toBe(200);
    const list2 = await get('/api/v1/partner/prices', partnerCookie);
    const row2 = (list2.json().data.plans as { plan_id: string; partner_price_points: string | null }[]).find((p) => p.plan_id === planId)!;
    expect(row2.partner_price_points).toBe('250');
  });

  it('a wallet sale deducts the COST automatically, fulfils the buyer, and earns no commission', async () => {
    const sale = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: buyer.email, external_reference: 'CTV-ORDER-1',
    });
    expect(sale.statusCode, sale.body).toBe(201);
    const data = sale.json().data;
    expect(data.price_points).toBe('250'); // partner's own price in points
    expect(data.price_minor).toBe('250000'); // = 250 points x 1,000 VND on the order
    expect(data.cost_points).toBe('180');
    expect(data.wallet_balance_points).toBe('370'); // 550 - 180
    const order = await ctx.db.query<{ status: string; total_minor: string }>('SELECT status, total_minor::text FROM orders WHERE id = $1', [data.order_id]);
    expect(order.rows[0]!.status).toBe('paid');
    expect(order.rows[0]!.total_minor).toBe('250000');
    const ent = await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM entitlements WHERE user_id = $1', [buyer.id]);
    expect(ent.rows[0]!.n).toBe('1');
    const commissions = await ctx.db.query<{ n: string }>('SELECT count(*)::text AS n FROM commission_entries WHERE partner_id = $1', [partnerId]);
    expect(commissions.rows[0]!.n).toBe('0'); // the cut IS the benefit; no double commission
    const entries = await ctx.db.query<{ kind: string; amount_points: string }>(
      "SELECT kind, amount_points::text FROM partner_wallet_entries WHERE partner_id = $1 AND kind = 'sale_deduction'", [partnerId]);
    expect(entries.rows[0]).toMatchObject({ kind: 'sale_deduction', amount_points: '-180' });
    // Audit payments M3: the sale row is 'pending' during settlement and
    // only reads 'completed' once phase 2 has delivered.
    const saleRow = await ctx.db.query<{ status: string }>(
      "SELECT status FROM partner_wallet_sales WHERE external_reference = 'CTV-ORDER-1'");
    expect(saleRow.rows[0]!.status).toBe('completed');
  });

  it('retrying the same external reference returns the same sale without a second deduction', async () => {
    const sale = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: buyer.email, external_reference: 'CTV-ORDER-1',
    });
    expect(sale.statusCode, sale.body).toBe(200);
    expect(sale.json().data.wallet_balance_points).toBe('370');
    expect(await walletBalanceViaApi()).toBe('370');
  });

  it('rejects a sale the wallet cannot cover and an unknown buyer', async () => {
    const second = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: 'wallet-buyer2@example.com', external_reference: 'CTV-ORDER-2',
    });
    expect(second.statusCode, second.body).toBe(201); // 370 points still covers 180 -> balance 190
    const third = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: 'wallet-buyer3@example.com', external_reference: 'CTV-ORDER-3',
    });
    expect(third.statusCode, third.body).toBe(201); // 190 covers one more -> 10 left
    const denied = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: buyer.email, external_reference: 'CTV-ORDER-4',
    });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().error.code).toBe('validation.failed');
    expect(denied.json().error.field_errors).toContainEqual({ field: 'wallet', code: 'partner.insufficient_balance' });
    const ghost = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: 'ghost@example.com', external_reference: 'CTV-ORDER-5',
    });
    expect(ghost.statusCode).toBe(422);
  });

  it('the admin policy endpoint updates the reseller cut', async () => {
    const policies = await get('/api/v1/admin/partner-policies', ownerCookie);
    expect(policies.statusCode, policies.body).toBe(200);
    const def = (policies.json().data as { id: string; code: string; reseller_discount_bps: number }[]).find((p) => p.code === 'default')!;
    expect(def.reseller_discount_bps).toBe(1000);
    const upd = await post(`/api/v1/admin/partner-policies/${def.id}`, { reseller_discount_bps: 1500 }, ownerCookie);
    expect(upd.statusCode, upd.body).toBe(200);
    const list = await get('/api/v1/partner/prices', partnerCookie);
    const row = (list.json().data.plans as { plan_id: string; cost_minor: string; cost_points: string }[]).find((p) => p.plan_id === planId)!;
    expect(row.cost_minor).toBe('170000'); // 200000 - 15%
    expect(row.cost_points).toBe('170');
    await post(`/api/v1/admin/partner-policies/${def.id}`, { reseller_discount_bps: 1000 }, ownerCookie);
  });

  it('rounds an odd VND cost UP to whole points and prices the default sale in points', async () => {
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '200' }, partnerCookie);
    const confirm = await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${t.json().data.id}/confirm`, {}, ownerCookie);
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(await walletBalanceViaApi()).toBe('210'); // 10 left + 200
    const list = await get('/api/v1/partner/prices', partnerCookie);
    const row = (list.json().data.plans as { plan_id: string; cost_minor: string; cost_points: string }[]).find((p) => p.plan_id === oddPlanId)!;
    expect(row.cost_minor).toBe('179999'); // exact: 199999 - 10%
    expect(row.cost_points).toBe('180'); // rounded UP to whole points
    const sale = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: oddPlanId, buyer_email: 'wallet-buyer4@example.com', external_reference: 'CTV-ORDER-ODD',
    });
    expect(sale.statusCode, sale.body).toBe(201);
    expect(sale.json().data.price_points).toBe('200'); // listed 199999 -> 200 points
    expect(sale.json().data.price_minor).toBe('200000');
    expect(sale.json().data.cost_points).toBe('180');
    expect(await walletBalanceViaApi()).toBe('30'); // 210 - 180
  });

  it('a category discount overrides the global cut for the wallet deduction', async () => {
    // Give the fixture template a category and pin a 25% partner discount on it.
    const cat = await ctx.db.query<{ id: string }>("INSERT INTO template_categories (code) VALUES ('wallet-cat') RETURNING id");
    const categoryId = cat.rows[0]!.id;
    await ctx.db.query('UPDATE templates SET category_id = $2 WHERE id = $1', [templateId, categoryId]);
    const setRes = await post('/api/v1/admin/partner-category-discounts', { items: [{ category_id: categoryId, discount_bps: 2500 }] }, ownerCookie);
    expect(setRes.statusCode, setRes.body).toBe(200);
    const listed = await get('/api/v1/admin/partner-category-discounts', ownerCookie);
    expect((listed.json().data as { category_id: string; discount_bps: number | null }[]).find((x) => x.category_id === categoryId)?.discount_bps).toBe(2500);
    // Prices: listed 199.999 -> 25% cut -> exact 149.999 -> 150 points, source category.
    const prices = await get('/api/v1/partner/prices', partnerCookie);
    const row = (prices.json().data.plans as { plan_id: string; cost_points: string; cost_source: string }[]).find((x) => x.plan_id === planId)!;
    expect(row.cost_points).toBe('150');
    expect(row.cost_source).toBe('category');
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '200' }, partnerCookie);
    await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${t.json().data.id}/confirm`, {}, ownerCookie);
    expect(await walletBalanceViaApi()).toBe('230'); // 30 left over + 200
    // The partner's own price is 250 points (set earlier); the deduction
    // is the category-cut cost of 150 — their retail never enters it.
    const sale = await api('POST', '/api/v1/partner/v1/wallet-sales', {
      template_id: templateId, plan_id: planId, buyer_email: 'wallet-buyer5@example.com', external_reference: 'CTV-ORDER-CATEGORY',
    });
    expect(sale.statusCode, sale.body).toBe(201);
    expect(sale.json().data.price_points).toBe('250');
    expect(sale.json().data.cost_points).toBe('150');
    expect(sale.json().data.cost_source).toBe('category');
    expect(sale.json().data.wallet_balance_points).toBe('80');
    // Clearing the category rate returns the plan to the global 10% cut.
    await post('/api/v1/admin/partner-category-discounts', { items: [{ category_id: categoryId, discount_bps: null }] }, ownerCookie);
    const prices2 = await get('/api/v1/partner/prices', partnerCookie);
    const row2 = (prices2.json().data.plans as { plan_id: string; cost_points: string; cost_source: string }[]).find((x) => x.plan_id === planId)!;
    expect(row2.cost_points).toBe('180');
    expect(row2.cost_source).toBe('policy');
  });

  it('accumulates a top-up paid in parts, closing only when fully paid (audit payments M1)', async () => {
    const before = BigInt(await walletBalanceViaApi());
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '100' }, partnerCookie);
    expect(t.statusCode, t.body).toBe(201);
    const code = t.json().data.code as string;
    const pay = (id: number, amount: number) => ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id, code, transferType: 'in', transferAmount: amount },
    });
    const part = await pay(555100001, 40000);
    expect(part.json().outcome).toBe('processed');
    expect(await walletBalanceViaApi()).toBe((before + 40n).toString());
    const mid = await ctx.db.query<{ status: string; paid_amount_minor: string }>(
      'SELECT status, paid_amount_minor::text FROM partner_topups WHERE code = $1', [code]);
    expect(mid.rows[0]).toMatchObject({ status: 'pending', paid_amount_minor: '40000' });
    const rest = await pay(555100002, 60000);
    expect(rest.json().outcome).toBe('processed');
    expect(await walletBalanceViaApi()).toBe((before + 100n).toString());
    const done = await ctx.db.query<{ status: string }>('SELECT status FROM partner_topups WHERE code = $1', [code]);
    expect(done.rows[0]!.status).toBe('paid');
  });

  it('caps an overpaid top-up at the requested points and flags it (audit payments M1)', async () => {
    const before = BigInt(await walletBalanceViaApi());
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '10' }, partnerCookie);
    expect(t.statusCode, t.body).toBe(201);
    const code = t.json().data.code as string;
    const hook = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 555100003, code, transferType: 'in', transferAmount: 25000 },
    });
    expect(hook.json().outcome).toBe('needs_reconciliation');
    expect(await walletBalanceViaApi()).toBe((before + 10n).toString()); // never more than requested
    const row = await ctx.db.query<{ status: string; paid_amount_minor: string }>(
      'SELECT status, paid_amount_minor::text FROM partner_topups WHERE code = $1', [code]);
    expect(row.rows[0]).toMatchObject({ status: 'paid', paid_amount_minor: '25000' });
  });

  it('manual top-up confirmation requires step-up, like manual payment confirmation (H1)', async () => {
    const t = await post('/api/v1/partner/wallet/topups', { amount_points: '25' }, partnerCookie);
    expect(t.statusCode, t.body).toBe(201);
    const topupId = t.json().data.id as string;
    // A fresh platform owner who has NOT elevated is refused…
    const fresh = await createUser(ctx, 'wallet-stepup@example.com', 'platform_owner');
    const denied = await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${topupId}/confirm`, {}, fresh.cookie);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain('auth.step_up_required');
    const still = await ctx.db.query<{ status: string }>('SELECT status FROM partner_topups WHERE id = $1', [topupId]);
    expect(still.rows[0]!.status).toBe('pending');
    // …and the same owner confirms once elevated.
    await stepUp(ctx, fresh.cookie);
    const ok = await post(`/api/v1/admin/partners/${partnerId}/wallet/topups/${topupId}/confirm`, {}, fresh.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.status).toBe('paid');
  });
});
