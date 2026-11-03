import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/**
 * Wave 3 (LOW findings) — payments:
 *  L2: a late `failed` event must not overwrite a settled attempt.
 *  L3: a quote is consumed by its first live order (code + migration 0042).
 *  L4: reconciliation resolve=paid reconciles expected vs received.
 *  L6 (code L-01): mock webhooks verify HMAC over the exact raw bytes.
 * Non-production mock behaviour (incl. role accounts) must stay intact —
 * production-only blocking lives in payment-production-gate.test.ts.
 */
let ctx: TestContext;
let ownerCookie: string;
let buyerCookie: string;
let buyerId: string;
let supportCookie: string;
let templateId: string;
let planId: string;
const TERMS = 'terms-2026-10';
const PRICE = '499000';

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'w3-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // reconciliation resolve=paid requires step-up
  const buyer = await createUser(ctx, 'w3-buyer@example.com');
  buyerCookie = buyer.cookie;
  buyerId = buyer.id;
  const support = await createUser(ctx, 'w3-support@example.com', 'support');
  supportCookie = support.cookie;

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('wave3-low-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu wave3', 'wave3-low-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/wave3-low-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['c'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'c'.repeat(64), artifact.rows[0]!.id],
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
}, 120_000);
afterAll(async () => ctx.close());

const post = (url: string, payload: unknown, cookie?: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...extra } });
const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });

async function newQuote(cookie: string): Promise<string> {
  const q = await post('/api/v1/quotes', { plan_id: planId, template_id: templateId }, cookie);
  expect(q.statusCode, q.body).toBe(201);
  return q.json().data.id as string;
}

async function orderFromQuote(cookie: string, quoteId: string) {
  return post('/api/v1/orders', { quote_id: quoteId, terms_version: TERMS }, cookie, { 'idempotency-key': randomUUID() });
}

async function newOrder(cookie: string): Promise<string> {
  const o = await orderFromQuote(cookie, await newQuote(cookie));
  expect(o.statusCode, o.body).toBe(201);
  return o.json().data.id as string;
}

async function mockSession(orderId: string, cookie: string): Promise<string> {
  const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, cookie);
  expect(s.statusCode, s.body).toBe(201);
  expect(s.json().data.provider).toBe('mock');
  return s.json().data.provider_ref as string;
}

async function attemptStatus(orderId: string): Promise<string> {
  const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId]);
  return rows[0]!.status;
}

function signRaw(raw: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', ctx.config.mockPaymentSecret).update(`${ts}.${raw}`).digest('hex');
  return { 'content-type': 'application/json', 'x-mock-timestamp': ts, 'x-mock-signature': `v1=${sig}` };
}

const postRaw = (url: string, raw: string, headers: Record<string, string>) =>
  ctx.app.inject({ method: 'POST', url, payload: raw, headers });

describe('L1 counterpart: non-production mock still works end to end, roles included', () => {
  it('a support-role account can create and settle a mock payment outside production', async () => {
    const orderId = await newOrder(supportCookie);
    const ref = await mockSession(orderId, supportCookie);
    const confirm = await post(`/api/v1/payments/mock/${ref}/confirm`, {}, supportCookie);
    expect(confirm.statusCode, confirm.body).toBe(202);
    expect((await get(`/api/v1/orders/${orderId}`, supportCookie)).json().data.payment_status).toBe('paid');
  });
});

describe('L2: a failed event must not overwrite a settled attempt', () => {
  it('a late failed event leaves the settled attempt and the paid order untouched', async () => {
    const orderId = await newOrder(buyerCookie);
    const ref = await mockSession(orderId, buyerCookie);
    const confirm = await post(`/api/v1/payments/mock/${ref}/confirm`, {}, buyerCookie);
    expect(confirm.statusCode, confirm.body).toBe(202);
    expect(await attemptStatus(orderId)).toBe('settled');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');

    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'failed', amountMinor: PRICE, currency: 'VND', eventId: `evt_latefail_${randomUUID()}` });
    const hook = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(hook.json().outcome).toBe('processed');
    expect(await attemptStatus(orderId)).toBe('settled');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
  });

  it('a failed event still fails a pending attempt (guard is not a blanket ignore)', async () => {
    const orderId = await newOrder(buyerCookie);
    const ref = await mockSession(orderId, buyerCookie);
    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'failed', amountMinor: PRICE, currency: 'VND', eventId: `evt_fail_${randomUUID()}` });
    const hook = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(await attemptStatus(orderId)).toBe('failed');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('awaiting_payment');
  });
});

describe('L3: a quote is consumed by its first live order', () => {
  it('rejects a second order from the same quote under a different Idempotency-Key', async () => {
    const quoteId = await newQuote(buyerCookie);
    const first = await orderFromQuote(buyerCookie, quoteId);
    expect(first.statusCode, first.body).toBe(201);
    const second = await orderFromQuote(buyerCookie, quoteId);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('order.quote_consumed');
    const { rows } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM orders WHERE quote_id = $1', [quoteId]);
    expect(rows[0]!.n).toBe('1');
  });

  it('a cancelled first order frees the quote for a new order', async () => {
    const quoteId = await newQuote(buyerCookie);
    const first = await orderFromQuote(buyerCookie, quoteId);
    expect(first.statusCode, first.body).toBe(201);
    const orderId = first.json().data.id as string;
    const cancel = await post(`/api/v1/orders/${orderId}/cancel`, {}, buyerCookie);
    expect(cancel.statusCode, cancel.body).toBe(200);
    const second = await orderFromQuote(buyerCookie, quoteId);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().data.id).not.toBe(orderId);
  });

  it('migration 0042 backstop: the partial unique index rejects a second live order at the DB level', async () => {
    const { rows } = await ctx.db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_quote_single_live_uq'",
    );
    expect(rows[0], 'index orders_quote_single_live_uq must exist').toBeTruthy();
    expect(rows[0]!.indexdef).toContain("status <> 'cancelled'");

    const quoteId = await newQuote(buyerCookie);
    const insert = (status: string) =>
      ctx.db.query(
        `INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version)
         VALUES ($1, $2, $3, 'VND', 499000, 499000, $4)`,
        [buyerId, quoteId, status, TERMS],
      );
    await insert('awaiting_payment');
    await expect(insert('paid')).rejects.toMatchObject({ code: '23505', constraint: 'orders_quote_single_live_uq' });
    // A cancelled order does not consume: inserting one first is fine,
    // and the API then still lets the buyer order from that quote.
    const quote2 = await newQuote(buyerCookie);
    await ctx.db.query(
      `INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version)
       VALUES ($1, $2, 'cancelled', 'VND', 499000, 499000, $3)`,
      [buyerId, quote2, TERMS],
    );
    const viaApi = await orderFromQuote(buyerCookie, quote2);
    expect(viaApi.statusCode, viaApi.body).toBe(201);
  });
});

describe('L4: reconciliation resolve=paid reconciles amounts', () => {
  async function seedReconOrder(total: number, settledAmounts: number[]): Promise<string> {
    const quote = await ctx.db.query<{ id: string }>(
      "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', $2, $2, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
      [buyerId, total],
    );
    const order = await ctx.db.query<{ id: string }>(
      `INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version)
       VALUES ($1, $2, 'needs_reconciliation', 'VND', $3, $3, $4) RETURNING id`,
      [buyerId, quote.rows[0]!.id, total, TERMS],
    );
    const orderId = order.rows[0]!.id;
    for (const amount of settledAmounts) {
      const ref = `WM${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      await ctx.db.query(
        `INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, settled_at)
         VALUES ($1, 'bank_transfer', $2, $3, 'VND', 'settled', now())`,
        [orderId, ref, amount],
      );
    }
    return orderId;
  }

  const resolve = (orderId: string, body: Record<string, unknown>) =>
    post(`/api/v1/admin/reconciliation/orders/${orderId}/resolve`, body, ownerCookie);

  it('rejects a shortfall resolve without an explicit override, reporting expected vs received', async () => {
    const orderId = await seedReconOrder(499000, [300000]);
    const res = await resolve(orderId, { resolution: 'paid', reason: 'Đã kiểm tra sao kê ngân hàng' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('reconciliation.shortfall_override_required');
    expect(res.json().error.field_errors).toContainEqual({ field: 'expected_minor', code: '499000' });
    expect(res.json().error.field_errors).toContainEqual({ field: 'received_minor', code: '300000' });
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0]!.status).toBe('needs_reconciliation');
  });

  it('a shortfall resolve with accept_shortfall + reason succeeds and audits expected/received/override', async () => {
    const orderId = await seedReconOrder(499000, [300000]);
    const res = await resolve(orderId, { resolution: 'paid', reason: 'Khách trả thiếu, chủ duyệt miễn phần còn lại', accept_shortfall: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ resolution: 'paid', expected_minor: '499000', received_minor: '300000', accept_shortfall: true });
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0]!.status).toBe('paid');
    const audit = await ctx.db.query<{ diff_redacted: { expected_minor?: string; received_minor?: string; accept_shortfall?: boolean } }>(
      "SELECT diff_redacted FROM audit_logs WHERE action = 'reconciliation.resolved' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1",
      [orderId],
    );
    expect(audit.rows[0]!.diff_redacted).toMatchObject({ expected_minor: '499000', received_minor: '300000', accept_shortfall: true });
  });

  it('a fully-covered resolve succeeds without any override', async () => {
    const orderId = await seedReconOrder(499000, [200000, 299000]);
    const res = await resolve(orderId, { resolution: 'paid', reason: 'Tiền về đủ qua hai lần chuyển' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ expected_minor: '499000', received_minor: '499000', accept_shortfall: false });
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(rows[0]!.status).toBe('paid');
  });

  it('an order with no settled attempts at all is a full shortfall, not a free fulfil', async () => {
    const orderId = await seedReconOrder(499000, []);
    const res = await resolve(orderId, { resolution: 'paid', reason: 'Chưa thấy tiền nhưng muốn cấp' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('reconciliation.shortfall_override_required');
    expect(res.json().error.field_errors).toContainEqual({ field: 'received_minor', code: '0' });
  });
});

describe('L-01: mock webhooks verify the HMAC over the exact raw bytes', () => {
  it('payment webhook: a signature over RAW bytes (dup keys, unicode escape, bare number) passes', async () => {
    const orderId = await newOrder(buyerCookie);
    const ref = await mockSession(orderId, buyerCookie);
    // Raw bytes deliberately differ from JSON.stringify(JSON.parse(raw)):
    // a duplicate "status" key, V as a unicode escape, amount as a
    // bare number, and non-canonical spacing.
    const raw = `{ "event_id": "evt_raw_${randomUUID()}", "provider_ref": "${ref}", "status": "failed", "status": "settled", "amount_minor": 499000, "currency": "\\u0056ND", "occurred_at": "2026-11-03T01:02:03.000Z" }`;
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    const res = await postRaw('/api/v1/payments/webhooks/mock', raw, signRaw(raw));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('processed');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
  });

  it('payment webhook: a signature over the RE-SERIALISED body fails when raw != re-serialised', async () => {
    const orderId = await newOrder(buyerCookie);
    const ref = await mockSession(orderId, buyerCookie);
    const raw = `{ "event_id": "evt_rawbad_${randomUUID()}", "provider_ref": "${ref}", "status": "settled", "amount_minor": 499000, "currency": "\\u0056ND", "occurred_at": "2026-11-03T01:02:03.000Z" }`;
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    const bad = await postRaw('/api/v1/payments/webhooks/mock', raw, signRaw(reserialised));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe('payment.webhook_invalid');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('awaiting_payment');
    // The same raw bytes signed correctly still settle afterwards —
    // the rejected attempt consumed nothing.
    const good = await postRaw('/api/v1/payments/webhooks/mock', raw, signRaw(raw));
    expect(good.statusCode, good.body).toBe(200);
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
  });

  async function paidOrderWithPendingRefund(): Promise<{ orderId: string; refundId: string; providerRef: string }> {
    const orderId = await newOrder(buyerCookie);
    const ref = await mockSession(orderId, buyerCookie);
    const confirm = await post(`/api/v1/payments/mock/${ref}/confirm`, {}, buyerCookie);
    expect(confirm.statusCode, confirm.body).toBe(202);
    const req = await post(`/api/v1/orders/${orderId}/refund-requests`, { amount_minor: PRICE, reason: 'đổi ý' }, buyerCookie);
    expect(req.statusCode, req.body).toBe(201);
    const refundId = req.json().data.id as string;
    const approve = await post(`/api/v1/admin/refunds/${refundId}/approve`, {}, ownerCookie);
    expect(approve.statusCode, approve.body).toBe(200);
    return { orderId, refundId, providerRef: approve.json().data.provider_ref as string };
  }

  it('refund webhook: a signature over RAW bytes passes and confirms the refund', async () => {
    const { orderId, refundId, providerRef } = await paidOrderWithPendingRefund();
    const raw = `{ "kind": "refund", "event_id": "evt_rfraw_${randomUUID()}", "refund_ref": "${providerRef}", "status": "failed", "status": "confirmed", "amount_minor": 499000, "currency": "\\u0056ND", "occurred_at": "2026-11-03T01:02:03.000Z" }`;
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    const res = await postRaw('/api/v1/payments/refund-webhooks/mock', raw, signRaw(raw));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('processed');
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM refunds WHERE id = $1', [refundId]);
    expect(rows[0]!.status).toBe('confirmed');
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('refunded');
  });

  it('refund webhook: a signature over the RE-SERIALISED body fails', async () => {
    const { refundId, providerRef } = await paidOrderWithPendingRefund();
    const raw = `{ "kind": "refund", "event_id": "evt_rfbad_${randomUUID()}", "refund_ref": "${providerRef}", "status": "confirmed", "amount_minor": 499000, "currency": "\\u0056ND", "occurred_at": "2026-11-03T01:02:03.000Z" }`;
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    const bad = await postRaw('/api/v1/payments/refund-webhooks/mock', raw, signRaw(reserialised));
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe('payment.webhook_invalid');
    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM refunds WHERE id = $1', [refundId]);
    expect(rows[0]!.status).toBe('pending');
  });
});
