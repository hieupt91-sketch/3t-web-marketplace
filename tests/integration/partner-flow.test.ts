/**
 * M6 partner: CTV application/approval, Partner API keys/scopes, checkout
 * sessions (AT-34/35/36), attribution + commission ledger (AT-37/38/39),
 * payouts with approver/settler separation (AT-40), key revoke/suspend
 * (AT-41), signed webhooks (AT-42) and SSRF guards (AT-43).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, IMPORT_JOB_TYPE, REPO_ROOT } from '@3t/core';
import { buildZip, type RawZipEntry } from '@3t/template-sdk/testing';
import { createPreviewServer } from '@3t/preview';
import { runImportJob } from '@3t/worker/pipeline';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let owner2: { id: string; cookie: string };
let buyer: { id: string; cookie: string };
let partnerUser: { id: string; cookie: string };
let partner2User: { id: string; cookie: string };
let closePreview: () => Promise<void>;
let templateId = '';
let planId = '';
let partnerId = '';
let partnerKey = '';
let profileId = '';
let webhookServer: Server;
let webhookPort = 0;
let received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
const TERMS = 'terms-2026-10';

beforeAll(async () => {
  ctx = await createTestContext({ partnerWebhookAllowLoopback: true });
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
  owner2 = await createUser(ctx, 'owner2@example.com', 'platform_owner');
  buyer = await createUser(ctx, 'buyer@example.com');
  partnerUser = await createUser(ctx, 'partner@example.com');
  partner2User = await createUser(ctx, 'partner2@example.com');
  // M7 step-up: sensitive partner/admin actions require a fresh elevation.
  for (const u of [owner, owner2, partnerUser, partner2User]) {
    const stepUp = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: as(u), payload: { password: 'correct horse battery staple' } });
    if (stepUp.statusCode !== 200) throw new Error(`step-up failed ${stepUp.statusCode} ${stepUp.body}`);
  }
  webhookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
  webhookPort = (webhookServer.address() as AddressInfo).port;
  await publishSelfhostTemplate();
  await approvePartner(partnerUser, 'partner@example.com');
});

afterAll(async () => {
  await closePreview();
  await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
  await ctx.close();
});

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });
const admin2 = () => ({ cookie: owner2.cookie, origin: ORIGIN });
const as = (u: { cookie: string }) => ({ cookie: u.cookie, origin: ORIGIN });
const keyAuth = (key: string) => ({ authorization: `Bearer ${key}` });

async function walk(dir: string, root = dir): Promise<RawZipEntry[]> {
  const out: RawZipEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ name: relative(root, full).split('\\').join('/'), data: await readFile(full), deflate: true });
  }
  return out;
}
async function drainImports() {
  for (;;) {
    const job = await claimJob(ctx.db, 'w', [IMPORT_JOB_TYPE], 60);
    if (!job) return;
    await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
  }
}
async function publishSelfhostTemplate() {
  const zip = buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
  const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'landing.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
  await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
  const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
  await drainImports();
  const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
  templateId = imp.json().data.draft.template_id;
  await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/templates/${templateId}/translations/vi`, headers: admin(), payload: { title: 'Mẫu landing', slug: 'mau-landing', status: 'published' } });
  const plan = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/plans`, headers: admin(), payload: { code: 'selfhost-standard', deployment_mode: 'selfhost', name: { vi: 'Selfhost' }, limits: { instance_limit: 1, updates_months: 12 } } });
  planId = plan.json().data.id;
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1000000', interval: 'one_time' } });
  const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${detail.json().data.plans[0].row_version}"` }, payload: { status: 'active' } });
  const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail2.headers.etag } });
}
async function approvePartner(user: { cookie: string }, email: string) {
  const apply = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/apply', headers: as(user), payload: { display_name: `Shop ${email}`, channel: 'website', domain: 'partner.example', description: 'test shop' } });
  expect(apply.statusCode, apply.body).toBe(201);
  const review = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/partners/${apply.json().data.id}/review`, headers: admin(), payload: { decision: 'approve' } });
  expect(review.statusCode, review.body).toBe(200);
  return apply.json().data.id as string;
}

/** Full partner journey: quote → session → claim → order → pay. Returns the paid order id. */
async function partnerPaidOrder(key: string, externalRef: string): Promise<string> {
  const quote = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/quotes', headers: keyAuth(key), payload: { template_id: templateId, plan_id: planId } });
  expect(quote.statusCode, quote.body).toBe(201);
  expect(quote.json().data.total_minor).toBe('1000000');
  const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(key), 'idempotency-key': randomUUID() }, payload: { quote_id: quote.json().data.id, external_reference: externalRef, return_url: 'https://partner.example/order-result', locale: 'vi' } });
  expect(session.statusCode, session.body).toBe(201);
  const checkoutUrl = new URL(session.json().data.checkout_url as string);
  const token = checkoutUrl.searchParams.get('token')!;
  const sessionId = session.json().data.id as string;
  const claim = await ctx.app.inject({ method: 'POST', url: `/api/v1/partner/checkout-sessions/${sessionId}/claim`, headers: as(buyer), payload: { claim_token: token } });
  expect(claim.statusCode, claim.body).toBe(200);
  const order = await ctx.app.inject({ method: 'POST', url: `/api/v1/partner/checkout-sessions/${sessionId}/order`, headers: as(buyer), payload: {} });
  expect(order.statusCode, order.body).toBe(201);
  const orderId = order.json().data.order_id as string;
  const paySession = await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) });
  expect(paySession.statusCode, paySession.body).toBe(201);
  const confirm = await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/${paySession.json().data.provider_ref}/confirm`, headers: as(buyer), payload: {} });
  expect(confirm.statusCode, confirm.body).toBe(202);
  const paid = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
  expect(paid.json().data.payment_status).toBe('paid');
  return orderId;
}
async function commissionEntries() {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/commissions', headers: as(partnerUser) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.entries as { kind: string; amount_minor: string; status: string }[];
}
async function balance() {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/balance', headers: as(partnerUser) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { pending: string; eligible: string; reserved: string; paid: string; available: string };
}
/** Point the partner at an instant-eligibility policy (hold 0 days) so the
 * payout test does not need to mutate the append-only ledger to fake time. */
async function setInstantPolicy() {
  const policy = await ctx.db.query<{ id: string }>(
    `INSERT INTO partner_policies (code, rate_bps, hold_days, payout_min_minor, applies_to) VALUES ('test-instant', 1000, 0, 10000, 'new') RETURNING id`,
  );
  await ctx.db.query('UPDATE partner_accounts SET policy_id = $2 WHERE id = $1', [partnerId, policy.rows[0]!.id]);
}
async function settleRefund(orderId: string, amount: string) {
  const req = await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/refund-requests`, headers: as(buyer), payload: { amount_minor: amount, reason: 'test' } });
  expect(req.statusCode, req.body).toBe(201);
  const approve = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/refunds/${req.json().data.id}/approve`, headers: admin(), payload: {} });
  expect(approve.statusCode, approve.body).toBe(200);
  const confirm = await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/refunds/${approve.json().data.provider_ref}/confirm`, headers: as(buyer), payload: {} });
  expect(confirm.statusCode, confirm.body).toBe(202);
}

describe('partner onboarding and Partner API', () => {
  it('activates the partner, issues a scoped key, and enforces scopes (AT-33/34)', async () => {
    const account = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/account', headers: as(partnerUser) });
    expect(account.statusCode, account.body).toBe(200);
    partnerId = account.json().data.id;
    expect(account.json().data.status).toBe('active');
    await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/settings', headers: as(partnerUser), payload: { return_domains: ['partner.example'] } });
    const profile = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/payout-profiles', headers: as(partnerUser), payload: { account_label: 'VCB ••1234' } });
    expect(profile.statusCode, profile.body).toBe(201);
    profileId = profile.json().data.id;
    const key = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/api-keys', headers: as(partnerUser), payload: { scopes: ['catalog:read', 'demo:link', 'checkout:create', 'orders:read', 'commissions:read', 'events:read'] } });
    expect(key.statusCode, key.body).toBe(201);
    partnerKey = key.json().data.secret as string;
    expect(partnerKey.startsWith('3tp_')).toBe(true);
    const catalog = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/v1/catalog', headers: keyAuth(partnerKey) });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().data.length).toBeGreaterThan(0);
    // A forged body field must never set the partner or the money (AT-34).
    const forged = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(partnerKey), 'idempotency-key': randomUUID() }, payload: { quote_id: randomUUID(), external_reference: 'forged-1', partner_id: '00000000-0000-0000-0000-000000000000', total_minor: '1', is_paid: true } });
    expect(forged.statusCode).toBe(422); // unknown partner_id/total/is_paid fields are rejected by the schema
    // Scope denial: a catalog-only key cannot create quotes.
    const narrow = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/api-keys', headers: as(partnerUser), payload: { scopes: ['catalog:read'] } });
    const denied = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/quotes', headers: keyAuth(narrow.json().data.secret), payload: { template_id: templateId, plan_id: planId } });
    expect(denied.statusCode).toBe(403);
    // Cross-partner isolation (AT-33): partner B cannot read partner A's order.
    const partner2Id = await approvePartner(partner2User, 'partner2@example.com');
    const key2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/api-keys', headers: as(partner2User), payload: { scopes: ['orders:read'] } });
    const order1 = await partnerPaidOrder(partnerKey, 'CTV-ORDER-0001');
    const cross = await ctx.app.inject({ method: 'GET', url: `/api/v1/partner/v1/orders/${order1}`, headers: keyAuth(key2.json().data.secret) });
    expect(cross.statusCode).toBe(404);
    expect(partner2Id).not.toBe(partnerId);
  });

  it('returns the same session on external_reference retry (AT-36) and rejects conflicts', async () => {
    const quote = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/quotes', headers: keyAuth(partnerKey), payload: { template_id: templateId, plan_id: planId } });
    const quoteId = quote.json().data.id as string;
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(partnerKey), 'idempotency-key': randomUUID() }, payload: { quote_id: quoteId, external_reference: 'CTV-RETRY-1', return_url: 'https://partner.example/order-result' } });
    expect(first.statusCode, first.body).toBe(201);
    const retry = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(partnerKey), 'idempotency-key': randomUUID() }, payload: { quote_id: quoteId, external_reference: 'CTV-RETRY-1', return_url: 'https://partner.example/order-result' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.id).toBe(first.json().data.id);
    const conflict = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(partnerKey), 'idempotency-key': randomUUID() }, payload: { quote_id: quoteId, external_reference: 'CTV-RETRY-1', return_url: 'https://partner.example/other' } });
    expect(conflict.statusCode).toBe(409);
    // Return URL outside the allowlist is denied.
    const denied = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/v1/checkout-sessions', headers: { ...keyAuth(partnerKey), 'idempotency-key': randomUUID() }, payload: { quote_id: quoteId, external_reference: 'CTV-RETRY-2', return_url: 'https://evil.example/x' } });
    expect(denied.statusCode).toBe(403);
  });
});

describe('commission ledger and refunds', () => {
  it('accrues 10% at settlement and nets to zero on partial then full refund (AT-38)', async () => {
    const orderId = await partnerPaidOrder(partnerKey, 'CTV-ORDER-0002');
    let entries = await commissionEntries();
    const accrued = entries.filter((e) => e.kind === 'accrued' && e.amount_minor === '100000');
    expect(accrued.length).toBeGreaterThan(0);
    let bal = await balance();
    // Order1 (previous test) + order2 both accrued 100000 and are still on hold.
    expect(bal.pending).toBe('200000');
    await settleRefund(orderId, '500000');
    entries = await commissionEntries();
    const reversals = entries.filter((e) => e.kind === 'reversal');
    expect(reversals.reduce((sum, e) => sum + BigInt(e.amount_minor), 0n)).toBe(-50000n);
    await settleRefund(orderId, '500000');
    entries = await commissionEntries();
    const total = entries.reduce((sum, e) => sum + BigInt(e.amount_minor), 0n);
    // Only this order's entries are counted here via a fresh partner? No — the
    // ledger is cumulative, so assert on reversal totals for this order's flow:
    // accrued 100000 (order2) + 100000 (order1) − 50000 − 50000 = 100000.
    expect(total).toBe(100000n);
  });
});

describe('payouts and webhooks', () => {
  it('reserves atomically, separates approver/settler, and releases on fail (AT-40)', async () => {
    await setInstantPolicy();
    const orderId = await partnerPaidOrder(partnerKey, 'CTV-ORDER-0003');
    let bal = await balance();
    // Only order3 is instantly eligible (orders 1–2 are still on 14-day hold).
    expect(bal.available).toBe('100000');
    const payout = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/payouts', headers: as(partnerUser), payload: { amount_minor: '60000', profile_id: profileId } });
    expect(payout.statusCode, payout.body).toBe(201);
    const payoutId = payout.json().data.id as string;
    // Second request above the remaining available balance is rejected
    // (available is 100000 − 60000 reserved = 40000 at this point).
    const over = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/payouts', headers: as(partnerUser), payload: { amount_minor: '50000', profile_id: profileId } });
    expect(over.statusCode).toBe(409);
    const approve = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${payoutId}/approve`, headers: admin(), payload: {} });
    expect(approve.statusCode, approve.body).toBe(200);
    // Same actor cannot settle their own approval.
    const sameActor = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${payoutId}/settle`, headers: admin(), payload: { evidence_ref: 'TRF-1' } });
    expect(sameActor.statusCode).toBe(403);
    const settle = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${payoutId}/settle`, headers: admin2(), payload: { evidence_ref: 'TRF-1' } });
    expect(settle.statusCode, settle.body).toBe(200);
    bal = await balance();
    expect(bal.paid).toBe('60000');
    // Fail releases the reservation exactly once.
    const payout2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/payouts', headers: as(partnerUser), payload: { amount_minor: '40000', profile_id: profileId } });
    expect(payout2.statusCode, payout2.body).toBe(201);
    const fail = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/payouts/${payout2.json().data.id}/fail`, headers: admin2(), payload: {} });
    expect(fail.statusCode, fail.body).toBe(200);
    bal = await balance();
    expect(bal.available).toBe('40000');
    // Refund after payout: payout history is unchanged; the reversal wipes this
    // order's commission, so net available goes to zero (AT-39).
    await settleRefund(orderId, '1000000');
    bal = await balance();
    expect(bal.paid).toBe('60000');
    expect(bal.available).toBe('0');
  });

  it('verifies webhook endpoints with signed test events and blocks private hosts (AT-42/43)', async () => {
    const internal = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/webhooks', headers: as(partnerUser), payload: { url: 'http://169.254.169.254/latest/meta-data', events: ['order.paid'] } });
    expect(internal.statusCode).toBe(400);
    const plain = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/webhooks', headers: as(partnerUser), payload: { url: 'http://example.com/hook', events: ['order.paid'] } });
    expect(plain.statusCode).toBe(400);
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/partner/webhooks', headers: as(partnerUser), payload: { url: `http://127.0.0.1:${webhookPort}/hook`, events: ['order.paid'] } });
    expect(created.statusCode, created.body).toBe(201);
    const secret = created.json().data.secret as string;
    received = [];
    const test = await ctx.app.inject({ method: 'POST', url: `/api/v1/partner/webhooks/${created.json().data.id}/test`, headers: as(partnerUser), payload: {} });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json().data.status).toBe('verified');
    expect(received.length).toBe(1);
    const delivery = received[0]!;
    const timestamp = delivery.headers['x-3t-timestamp'] as string;
    const signature = delivery.headers['x-3t-signature'] as string;
    const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${delivery.body}`).digest('hex')}`;
    expect(signature).toBe(expected);
    expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(300);
  });

  it('revoke and suspend block new API use but keep bought rights (AT-41)', async () => {
    const orderId = await partnerPaidOrder(partnerKey, 'CTV-ORDER-0004');
    const keys = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/api-keys', headers: as(partnerUser) });
    const fullKey = keys.json().data.find((k: { scopes: string[] }) => k.scopes.includes('checkout:create'));
    const revoke = await ctx.app.inject({ method: 'POST', url: `/api/v1/partner/api-keys/${fullKey.id}/revoke`, headers: as(partnerUser), payload: {} });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/partner/v1/catalog', headers: keyAuth(partnerKey) });
    expect(denied.statusCode).toBe(401);
    const suspend = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/partners/${partnerId}/review`, headers: admin(), payload: { decision: 'suspend', reason: 'test' } });
    expect(suspend.statusCode, suspend.body).toBe(200);
    const entitlement = await ctx.db.query<{ status: string }>(
      `SELECT status FROM entitlements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
      [orderId],
    );
    expect(entitlement.rows[0]?.status).toBe('active');
    const order = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
    expect(order.json().data.payment_status).toBe('paid');
  });
});
