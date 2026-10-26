import type { PoolClient } from '@3t/core';

/**
 * Partner commission ledger (docs/06 §7).
 * Entries are append-only (DB trigger): amounts are never edited and statuses
 * never mutated. Eligibility is computed from eligible_at, reservations are
 * payout_allocations for payouts in an active state, and paid amounts are
 * allocations for paid payouts. A reversal is a new negative entry linked to
 * the original accrual — payout history is never rewritten (AT-38/AT-39).
 */
export function commissionFor(baseMinor: bigint, rateBps: number): bigint {
  if (baseMinor <= 0n || rateBps <= 0) return 0n;
  return (baseMinor * BigInt(rateBps)) / 10000n;
}

/** Accrue one entry per order item at settlement, from the policy snapshot. */
export async function accrueOrderCommission(
  client: PoolClient,
  orderId: string,
): Promise<void> {
  const attribution = await client.query<{ partner_id: string; policy_snapshot: { rate_bps: number; hold_days: number; policy_version: string } }>(
    'SELECT partner_id, policy_snapshot FROM attributions WHERE order_id = $1',
    [orderId],
  );
  if (!attribution.rows[0]) return;
  const { partner_id, policy_snapshot } = attribution.rows[0]!;
  const items = await client.query<{ id: string; unit_price_minor: string; discount_minor: string; tax_minor: string }>(
    'SELECT id, unit_price_minor::text, discount_minor::text, tax_minor::text FROM order_items WHERE order_id = $1',
    [orderId],
  );
  for (const item of items.rows) {
    // Base = price after discount, before tax (docs/06 §7).
    const base = BigInt(item.unit_price_minor) - BigInt(item.discount_minor);
    const amount = commissionFor(base, policy_snapshot.rate_bps);
    if (amount <= 0n) continue;
    const holdDays = policy_snapshot.hold_days ?? 14;
    await client.query(
      `INSERT INTO commission_entries (partner_id, order_id, order_item_id, kind, status, amount_minor, base_minor, rate_bps, policy_version, eligible_at)
       VALUES ($1, $2, $3, 'accrued', $4, $5, $6, $7, $8, now() + make_interval(days => $9))
       ON CONFLICT DO NOTHING`,
      [partner_id, orderId, item.id, holdDays > 0 ? 'pending' : 'eligible', amount.toString(), base.toString(), policy_snapshot.rate_bps, policy_snapshot.policy_version, holdDays],
    );
  }
}

/**
 * Reversal after a confirmed refund (AT-38): cumulative reversal =
 * original accrued − still-valid commission − reversals already recorded.
 * Still-valid uses the order's remaining (unrefunded) commission base.
 */
export async function reverseOrderCommission(client: PoolClient, orderId: string): Promise<void> {
  const attribution = await client.query<{ partner_id: string; policy_snapshot: { rate_bps: number } }>(
    'SELECT partner_id, policy_snapshot FROM attributions WHERE order_id = $1',
    [orderId],
  );
  if (!attribution.rows[0]) return;
  const { partner_id, policy_snapshot } = attribution.rows[0]!;
  const accrued = await client.query<{ total: string; item_id: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total,
            (SELECT order_item_id FROM commission_entries WHERE order_id = $1 AND kind = 'accrued' ORDER BY created_at ASC LIMIT 1) AS item_id
     FROM commission_entries WHERE order_id = $1 AND kind = 'accrued'`,
    [orderId],
  );
  const original = BigInt(accrued.rows[0]!.total);
  if (original <= 0n) return;
  const reversed = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM commission_entries WHERE order_id = $1 AND kind = 'reversal'`,
    [orderId],
  );
  const alreadyReversed = -BigInt(reversed.rows[0]!.total);
  const base = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(unit_price_minor - discount_minor), 0)::text AS total FROM order_items WHERE order_id = $1`,
    [orderId],
  );
  const refunded = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM refunds WHERE order_id = $1 AND status = 'confirmed'`,
    [orderId],
  );
  const remaining = BigInt(base.rows[0]!.total) - BigInt(refunded.rows[0]!.total);
  const valid = commissionFor(remaining > 0n ? remaining : 0n, policy_snapshot.rate_bps);
  const reversal = original - valid - alreadyReversed;
  if (reversal <= 0n) return;
  // The reversal inherits the original accrual's eligibility timing: refunding
  // an order still on hold must reduce pending commission, not commission that
  // is already eligible from other orders.
  await client.query(
    `INSERT INTO commission_entries (partner_id, order_id, order_item_id, kind, status, amount_minor, base_minor, rate_bps, policy_version, related_entry_id, reason, eligible_at)
     SELECT $1, $2, $3, 'reversal',
            CASE WHEN MIN(e.eligible_at) > now() THEN 'pending' ELSE 'eligible' END,
            $4, 0, $5, 'default', NULL, 'refund_settled', MIN(e.eligible_at)
     FROM commission_entries e WHERE e.order_id = $2 AND e.kind = 'accrued'`,
    [partner_id, orderId, accrued.rows[0]!.item_id, (-reversal).toString(), policy_snapshot.rate_bps],
  );
}

/** Balance buckets computed from the immutable ledger + allocation states. */
export async function partnerBalance(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  partnerId: string,
): Promise<{ pending: string; eligible: string; reserved: string; paid: string; available: string }> {
  const sums = await db.query<{ bucket: string; total: string }>(
    `SELECT 'accrued_eligible' AS bucket, COALESCE(SUM(amount_minor), 0)::text AS total FROM commission_entries
      WHERE partner_id = $1 AND kind = 'accrued' AND eligible_at <= now()
     UNION ALL SELECT 'accrued_pending', COALESCE(SUM(amount_minor), 0)::text FROM commission_entries
      WHERE partner_id = $1 AND kind = 'accrued' AND eligible_at > now()
     UNION ALL SELECT 'reversals_eligible', COALESCE(SUM(amount_minor), 0)::text FROM commission_entries
      WHERE partner_id = $1 AND kind = 'reversal' AND eligible_at <= now()
     UNION ALL SELECT 'reversals_pending', COALESCE(SUM(amount_minor), 0)::text FROM commission_entries
      WHERE partner_id = $1 AND kind = 'reversal' AND eligible_at > now()
     UNION ALL SELECT 'adjustments', COALESCE(SUM(amount_minor), 0)::text FROM commission_entries
      WHERE partner_id = $1 AND kind = 'adjustment'
     UNION ALL SELECT 'reserved', COALESCE(SUM(a.amount_minor), 0)::text FROM payout_allocations a
      JOIN payout_requests p ON p.id = a.payout_id WHERE p.partner_id = $1 AND p.status IN ('requested', 'approved', 'processing')
     UNION ALL SELECT 'paid', COALESCE(SUM(a.amount_minor), 0)::text FROM payout_allocations a
      JOIN payout_requests p ON p.id = a.payout_id WHERE p.partner_id = $1 AND p.status = 'paid'`,
    [partnerId],
  );
  const byBucket = Object.fromEntries(sums.rows.map((r) => [r.bucket, BigInt(r.total)]));
  const eligibleGross = (byBucket.accrued_eligible ?? 0n) + (byBucket.reversals_eligible ?? 0n) + (byBucket.adjustments ?? 0n);
  const reserved = byBucket.reserved ?? 0n;
  const paid = byBucket.paid ?? 0n;
  const eligible = eligibleGross - reserved - paid;
  return {
    pending: ((byBucket.accrued_pending ?? 0n) + (byBucket.reversals_pending ?? 0n)).toString(),
    eligible: eligible.toString(),
    reserved: reserved.toString(),
    paid: paid.toString(),
    available: (eligible > 0n ? eligible : 0n).toString(),
  };
}
