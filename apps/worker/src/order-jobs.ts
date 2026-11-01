import { emitEvent, tx, writeAudit, type Db } from '@3t/core';

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
