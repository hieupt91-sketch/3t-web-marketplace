import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/**
 * Audit payments M4: approving a refund for an order paid through a real
 * provider must record the EXTERNAL reference of the refund transfer the
 * staff member executed (bank transaction id / gateway refund id) — the
 * platform must not stamp a fabricated `mockrefund_…` reference on
 * real money. Internally-settled providers (mock) keep generated refs.
 */
let ctx: TestContext;
let ownerCookie: string;
let buyerId: string;

const post = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });

async function seedPaidOrder(provider: string, ref: string): Promise<{ orderId: string; refundId: string }> {
  const quote = await ctx.db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 199000, 199000, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [buyerId],
  );
  const order = await ctx.db.query<{ id: string }>(
    `INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version)
     VALUES ($1, $2, 'paid', 'VND', 199000, 199000, 'terms-2026-10') RETURNING id`,
    [buyerId, quote.rows[0]!.id],
  );
  await ctx.db.query(
    `INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json, settled_at)
     VALUES ($1, $2, $3, 199000, 'VND', 'settled', '{}'::jsonb, now())`,
    [order.rows[0]!.id, provider, ref],
  );
  const refund = await ctx.db.query<{ id: string }>(
    `INSERT INTO refunds (order_id, buyer_id, amount_minor, currency, reason, requested_by)
     VALUES ($1, $2, 199000, 'VND', 'buyer asked', $2) RETURNING id`,
    [order.rows[0]!.id, buyerId],
  );
  return { orderId: order.rows[0]!.id, refundId: refund.rows[0]!.id };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'refund-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  const buyer = await createUser(ctx, 'refund-buyer@example.com');
  buyerId = buyer.id;
}, 120_000);

afterAll(async () => ctx.close());

describe('refund approval evidence (payments M4)', () => {
  it('refuses to approve a bank-paid refund without an evidence reference', async () => {
    const { refundId } = await seedPaidOrder('bank_transfer', 'WMEVID0001');
    const res = await post(`/api/v1/admin/refunds/${refundId}/approve`, {}, ownerCookie);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.field_errors).toContainEqual({ field: 'evidence_ref', code: 'required' });
    const row = await ctx.db.query<{ status: string }>('SELECT status FROM refunds WHERE id = $1', [refundId]);
    expect(row.rows[0]!.status).toBe('requested');
  });

  it('records the staff-supplied external reference and the real provider', async () => {
    const { refundId } = await seedPaidOrder('bank_transfer', 'WMEVID0002');
    const res = await post(`/api/v1/admin/refunds/${refundId}/approve`, { evidence_ref: 'FT24123456789' }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.provider_ref).toBe('FT24123456789');
    const row = await ctx.db.query<{ status: string; provider: string; provider_ref: string }>(
      'SELECT status, provider, provider_ref FROM refunds WHERE id = $1', [refundId]);
    expect(row.rows[0]).toMatchObject({ status: 'pending', provider: 'bank_transfer', provider_ref: 'FT24123456789' });
  });

  it('rejects reusing the same evidence reference for a second refund', async () => {
    const { refundId } = await seedPaidOrder('bank_transfer', 'WMEVID0003');
    const res = await post(`/api/v1/admin/refunds/${refundId}/approve`, { evidence_ref: 'FT24123456789' }, ownerCookie);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('still generates a reference for internally-settled mock payments', async () => {
    const { refundId } = await seedPaidOrder('mock', 'mockpay_1');
    const res = await post(`/api/v1/admin/refunds/${refundId}/approve`, {}, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.provider_ref).toMatch(/^mockrefund_/);
    const row = await ctx.db.query<{ provider: string }>('SELECT provider FROM refunds WHERE id = $1', [refundId]);
    expect(row.rows[0]!.provider).toBe('mock');
  });
});
