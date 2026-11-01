import type { PoolClient } from '@3t/core';

/**
 * Partner wallet (docs/06 §11): a prepaid balance the platform deducts
 * from automatically on wallet direct sales. The unit of account is the
 * POINT — 1 point = 1,000 VND — so partners work with small round
 * numbers; VND only appears at the boundaries (a top-up transfers
 * points × 1,000 VND; an order total is price_points × 1,000 VND).
 * All mutations run inside the caller's transaction with the wallet
 * row locked, and every change lands in the append-only ledger with
 * its post-balance.
 */

export const POINT_VND = 1000n;

type Client = PoolClient | { query: PoolClient['query'] };

export async function ensureWallet(client: Client, partnerId: string): Promise<void> {
  await client.query('INSERT INTO partner_wallets (partner_id) VALUES ($1) ON CONFLICT (partner_id) DO NOTHING', [partnerId]);
}

/** Current balance in points. */
export async function walletBalance(client: Client, partnerId: string): Promise<bigint> {
  await ensureWallet(client, partnerId);
  const { rows } = await client.query<{ balance_points: string }>('SELECT balance_points::text FROM partner_wallets WHERE partner_id = $1', [partnerId]);
  return BigInt(rows[0]?.balance_points ?? '0');
}

async function applyEntry(
  client: Client,
  partnerId: string,
  kind: 'topup' | 'sale_deduction' | 'sale_refund' | 'adjustment',
  amountPoints: bigint,
  refType: string,
  refId: string | null,
  note: string,
): Promise<bigint> {
  await ensureWallet(client, partnerId);
  const { rows } = await client.query<{ balance_points: string }>(
    'SELECT balance_points::text FROM partner_wallets WHERE partner_id = $1 FOR UPDATE',
    [partnerId],
  );
  const next = BigInt(rows[0]!.balance_points) + amountPoints;
  if (next < 0n) throw new Error('partner_wallet_negative');
  await client.query('UPDATE partner_wallets SET balance_points = $2 WHERE partner_id = $1', [partnerId, next.toString()]);
  await client.query(
    `INSERT INTO partner_wallet_entries (partner_id, kind, amount_points, balance_after_points, ref_type, ref_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [partnerId, kind, amountPoints.toString(), next.toString(), refType, refId, note],
  );
  return next;
}

export function creditWallet(client: Client, partnerId: string, amountPoints: bigint, kind: 'topup' | 'sale_refund' | 'adjustment', refType: string, refId: string | null, note = ''): Promise<bigint> {
  if (amountPoints <= 0n) throw new Error('partner_wallet_amount');
  return applyEntry(client, partnerId, kind, amountPoints, refType, refId, note);
}

export async function debitWallet(client: Client, partnerId: string, amountPoints: bigint, kind: 'sale_deduction' | 'adjustment', refType: string, refId: string | null, note = ''): Promise<{ ok: boolean; balance: bigint }> {
  if (amountPoints <= 0n) throw new Error('partner_wallet_amount');
  const balance = await walletBalance(client, partnerId);
  // The locked re-read inside applyEntry is authoritative; this pre-check
  // only avoids writing an entry we would have to roll back anyway.
  if (balance < amountPoints) return { ok: false, balance };
  const next = await applyEntry(client, partnerId, kind, -amountPoints, refType, refId, note);
  return { ok: true, balance: next };
}

/** The partner's exact VND cost for a listed charge: listed minus the policy cut. */
export function partnerCost(listedMinor: bigint, cutBps: number): bigint {
  return (listedMinor * BigInt(10000 - cutBps)) / 10000n;
}

/**
 * The cost actually deducted, in whole points: the exact VND cost
 * rounded UP to the next point, so a deduction always covers the cost.
 * The prices page shows this number — it is never a surprise.
 */
export function partnerCostPoints(listedMinor: bigint, cutBps: number): bigint {
  const exact = partnerCost(listedMinor, cutBps);
  return (exact + POINT_VND - 1n) / POINT_VND;
}

/**
 * The deduction for one sale of a plan, resolved in order:
 * 1. the owner's fixed partner price for the plan (plan_partner_costs),
 *    in points — the partner's own retail price plays no role at all;
 * 2. the policy % cut on the listed price, converted to points.
 */
export async function resolvePartnerCostPoints(
  client: Client,
  planId: string,
  listedMinor: bigint,
  cutBps: number,
): Promise<{ points: bigint; exactMinor: bigint; source: 'fixed' | 'cut' }> {
  const { rows } = await client.query<{ cost_points: string }>('SELECT cost_points::text FROM plan_partner_costs WHERE plan_id = $1', [planId]);
  if (rows[0]) {
    const points = BigInt(rows[0].cost_points);
    return { points, exactMinor: pointsToVnd(points), source: 'fixed' };
  }
  return { points: partnerCostPoints(listedMinor, cutBps), exactMinor: partnerCost(listedMinor, cutBps), source: 'cut' };
}

/** A whole-point price for a VND amount (rounds up, like the cost). */
export function vndToPointsCeil(amountMinor: bigint): bigint {
  return (amountMinor + POINT_VND - 1n) / POINT_VND;
}

export function pointsToVnd(points: bigint): bigint {
  return points * POINT_VND;
}
