import { emitEvent, tx, writeAudit, type Db } from '@3t/core';

/**
 * Stuck wallet-sale recovery (audit payments M3). A partner-v1 wallet sale
 * debits the wallet in phase 1 and settles in phase 2; the sale row is
 * 'pending' in between. If the API died in that window the partner was
 * charged for an undelivered sale. This sweep takes 'pending' sales older
 * than 10 minutes (phase 2 normally finishes in seconds):
 *  - order already paid → the sale WAS delivered; mark it 'completed'.
 *  - otherwise → credit the cost back to the wallet (same ledger shape as
 *    the API's creditWallet('sale_refund')), mark the sale 'refunded' and
 *    cancel the still-unpaid order.
 */
export async function refundStuckWalletSales(db: Db): Promise<{ refunded: number; reconciled: number }> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM partner_wallet_sales WHERE status = 'pending' AND created_at < now() - interval '10 minutes' ORDER BY created_at LIMIT 100",
  );
  let refunded = 0;
  let reconciled = 0;
  for (const s of rows) {
    await tx(db, async (client) => {
      const sale = await client.query<{ partner_id: string; order_id: string; cost_points: string; status: string }>(
        'SELECT partner_id, order_id, cost_points::text, status FROM partner_wallet_sales WHERE id = $1 FOR UPDATE',
        [s.id],
      );
      const row = sale.rows[0];
      if (!row || row.status !== 'pending') return;
      const order = await client.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [row.order_id]);
      if (order.rows[0]?.status === 'paid') {
        await client.query("UPDATE partner_wallet_sales SET status = 'completed' WHERE id = $1", [s.id]);
        await writeAudit(client, { actorType: 'system', actorId: null, action: 'partner.wallet_sale_reconciled', resourceType: 'partner_wallet_sale', resourceId: s.id, traceId: 'worker-sweep' });
        reconciled++;
        return;
      }
      // Wallet credit mirroring apps/api creditWallet('sale_refund'):
      // locked wallet row, balance update, append-only ledger entry.
      await client.query('INSERT INTO partner_wallets (partner_id) VALUES ($1) ON CONFLICT (partner_id) DO NOTHING', [row.partner_id]);
      const wallet = await client.query<{ balance_points: string }>('SELECT balance_points::text FROM partner_wallets WHERE partner_id = $1 FOR UPDATE', [row.partner_id]);
      const next = BigInt(wallet.rows[0]!.balance_points) + BigInt(row.cost_points);
      await client.query('UPDATE partner_wallets SET balance_points = $2 WHERE partner_id = $1', [row.partner_id, next.toString()]);
      await client.query(
        `INSERT INTO partner_wallet_entries (partner_id, kind, amount_points, balance_after_points, ref_type, ref_id, note)
         VALUES ($1, 'sale_refund', $2, $3, 'partner_wallet_sale', $4, 'settlement_stuck_sweep')`,
        [row.partner_id, row.cost_points, next.toString(), s.id],
      );
      await client.query("UPDATE partner_wallet_sales SET status = 'refunded' WHERE id = $1", [s.id]);
      await client.query("UPDATE orders SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1 AND status = 'awaiting_payment'", [row.order_id]);
      await writeAudit(client, { actorType: 'system', actorId: null, action: 'partner.wallet_sale_sweep_refund', resourceType: 'partner_wallet_sale', resourceId: s.id, traceId: 'worker-sweep', diff: { cost_points: row.cost_points } });
      refunded++;
    });
  }
  return { refunded, reconciled };
}

/**
 * Payment-window expiry (owner rule 2026-11-01): an order left unpaid for
 * ~15 minutes is cancelled automatically — status 'expired', its pending
 * attempts 'expired' with it, audit + outbox event per order — so neither
 * the buyer nor the admin ever stares at an eternal "awaiting payment".
 * Late money is not dropped: hub/IPN reports route the order to
 * reconciliation, and a staff manual confirmation revives it. The API
 * expires lazily on the payment-session path too; this sweep keeps lists
 * and dashboards honest without anyone opening the order.
 */
export async function expireStalePaymentOrders(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string; buyer_id: string }>(
    "SELECT id, buyer_id FROM orders WHERE status = 'awaiting_payment' AND payment_window_expires_at IS NOT NULL AND payment_window_expires_at <= now() ORDER BY payment_window_expires_at LIMIT 200",
  );
  let expired = 0;
  for (const o of rows) {
    await tx(db, async (client) => {
      const cur = await client.query<{ status: string; payment_window_expires_at: Date | null }>(
        'SELECT status, payment_window_expires_at FROM orders WHERE id = $1 FOR UPDATE',
        [o.id],
      );
      const row = cur.rows[0];
      if (!row || row.status !== 'awaiting_payment' || !row.payment_window_expires_at || row.payment_window_expires_at > new Date()) return;
      await client.query("UPDATE orders SET status = 'expired', row_version = row_version + 1 WHERE id = $1", [o.id]);
      await client.query("UPDATE payment_attempts SET status = 'expired' WHERE order_id = $1 AND status = 'pending'", [o.id]);
      await emitEvent(client, 'order.expired', 'order', o.id, { order_id: o.id, buyer_id: o.buyer_id, reason: 'payment_window' });
      await writeAudit(client, { actorType: 'system', actorId: null, action: 'order.expired', resourceType: 'order', resourceId: o.id, traceId: 'worker-sweep', diff: { reason: 'payment_window' } });
      expired++;
    });
  }
  return expired;
}
