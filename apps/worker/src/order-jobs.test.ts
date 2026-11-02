import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@3t/core/testing';
import type { Db } from '@3t/core';
import { refundStuckWalletSales } from './order-jobs.js';

/**
 * Audit payments M3: a wallet sale stuck in 'pending' (API died between
 * the phase-1 debit and phase-2 settlement) must not keep the partner's
 * money. The sweep refunds undelivered sales and reconciles delivered
 * ones (order paid) instead of refunding them.
 */
let db: Db;
let drop: () => Promise<void>;
let partnerId: string;

async function seedSale(opts: { ref: string; orderStatus: string; ageMinutes: number; costPoints?: number }): Promise<{ saleId: string; orderId: string }> {
  const buyer = await db.query<{ id: string }>(
    "INSERT INTO users (email_normalized, display_name, password_hash, verified_at) VALUES ($1, 'Buyer', 'x', now()) RETURNING id",
    [`sweep-buyer-${opts.ref.toLowerCase()}@example.com`],
  );
  const quote = await db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 100000, 100000, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [buyer.rows[0]!.id],
  );
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version)
     VALUES ($1, $2, $3, 'VND', 100000, 100000, 'terms-2026-10') RETURNING id`,
    [buyer.rows[0]!.id, quote.rows[0]!.id, opts.orderStatus],
  );
  const tpl = await db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [`sweep-${opts.ref.toLowerCase()}`, buyer.rows[0]!.id],
  );
  const plan = await db.query<{ id: string }>(
    "INSERT INTO plans (template_id, code, deployment_mode, name_json) VALUES ($1, 'co-ban', 'selfhost', '{\"vi\":\"Cơ bản\"}'::jsonb) RETURNING id",
    [tpl.rows[0]!.id],
  );
  const sale = await db.query<{ id: string }>(
    `INSERT INTO partner_wallet_sales (partner_id, order_id, external_reference, buyer_id, plan_id, listed_minor, cut_bps, cost_minor, price_minor, cost_points, price_points, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 100000, 1000, 90000, 100000, $6, 100, 'pending', now() - make_interval(mins => $7)) RETURNING id`,
    [partnerId, order.rows[0]!.id, opts.ref, buyer.rows[0]!.id, plan.rows[0]!.id, opts.costPoints ?? 90, opts.ageMinutes],
  );
  return { saleId: sale.rows[0]!.id, orderId: order.rows[0]!.id };
}

async function balance(): Promise<string> {
  const { rows } = await db.query<{ balance_points: string }>('SELECT balance_points::text FROM partner_wallets WHERE partner_id = $1', [partnerId]);
  return rows[0]!.balance_points;
}

beforeAll(async () => {
  const made = await createTestDatabase();
  db = made.pool;
  drop = made.drop;
  const owner = await db.query<{ id: string }>(
    "INSERT INTO users (email_normalized, display_name, password_hash, verified_at) VALUES ('sweep-partner@example.com', 'Partner', 'x', now()) RETURNING id",
  );
  const partner = await db.query<{ id: string }>(
    "INSERT INTO partner_accounts (user_id, code, display_name, status) VALUES ($1, 'p_sweep', 'Sweep Partner', 'active') RETURNING id",
    [owner.rows[0]!.id],
  );
  partnerId = partner.rows[0]!.id;
  await db.query('INSERT INTO partner_wallets (partner_id, balance_points) VALUES ($1, 100)', [partnerId]);
}, 120_000);

afterAll(async () => {
  await drop(); // drop() ends the pool itself
});

describe('refundStuckWalletSales', () => {
  it('refunds a stuck pending sale whose order never got paid', async () => {
    const { saleId, orderId } = await seedSale({ ref: 'SWEEP-REFUND', orderStatus: 'awaiting_payment', ageMinutes: 30 });
    const result = await refundStuckWalletSales(db);
    expect(result.refunded).toBe(1);
    expect(await balance()).toBe('190'); // 100 + 90 cost back
    const sale = await db.query<{ status: string }>('SELECT status FROM partner_wallet_sales WHERE id = $1', [saleId]);
    expect(sale.rows[0]!.status).toBe('refunded');
    const order = await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0]!.status).toBe('cancelled');
    const entry = await db.query<{ kind: string; note: string }>(
      "SELECT kind, note FROM partner_wallet_entries WHERE ref_id = $1", [saleId]);
    expect(entry.rows[0]).toMatchObject({ kind: 'sale_refund', note: 'settlement_stuck_sweep' });
  });

  it('reconciles a pending sale whose order WAS paid instead of refunding it', async () => {
    const { saleId } = await seedSale({ ref: 'SWEEP-PAID', orderStatus: 'paid', ageMinutes: 30 });
    const result = await refundStuckWalletSales(db);
    expect(result).toMatchObject({ refunded: 0, reconciled: 1 });
    expect(await balance()).toBe('190'); // unchanged: delivered sales keep the debit
    const sale = await db.query<{ status: string }>('SELECT status FROM partner_wallet_sales WHERE id = $1', [saleId]);
    expect(sale.rows[0]!.status).toBe('completed');
  });

  it('leaves fresh pending sales alone (phase 2 may still be running)', async () => {
    const { saleId } = await seedSale({ ref: 'SWEEP-FRESH', orderStatus: 'awaiting_payment', ageMinutes: 1 });
    const result = await refundStuckWalletSales(db);
    expect(result).toMatchObject({ refunded: 0, reconciled: 0 });
    const sale = await db.query<{ status: string }>('SELECT status FROM partner_wallet_sales WHERE id = $1', [saleId]);
    expect(sale.rows[0]!.status).toBe('pending');
  });
});
