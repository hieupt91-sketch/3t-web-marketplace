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

/** The category's partner discount in bps, or null when the category
 *  has no override (the policy's global cut then applies). */
export async function categoryDiscountBps(client: Client, categoryId: string | null): Promise<number | null> {
  if (!categoryId) return null;
  const { rows } = await client.query<{ discount_bps: number }>('SELECT discount_bps FROM partner_category_discounts WHERE category_id = $1', [categoryId]);
  return rows[0]?.discount_bps ?? null;
}

/**
 * The deduction for one sale, in points. Partner pricing is a % cut on
 * the listed price only (owner decision, v32): the template's category
 * rate when the owner set one for that category, otherwise the partner
 * policy's global cut. What the partner charges their own customer
 * never enters this math.
 */
export async function resolvePartnerCostPoints(
  client: Client,
  args: { categoryId: string | null; listedMinor: bigint; policyCutBps: number },
): Promise<{ points: bigint; exactMinor: bigint; cutBps: number; source: 'category' | 'policy' }> {
  const categoryBps = await categoryDiscountBps(client, args.categoryId);
  const cutBps = categoryBps ?? args.policyCutBps;
  return {
    points: partnerCostPoints(args.listedMinor, cutBps),
    exactMinor: partnerCost(args.listedMinor, cutBps),
    cutBps,
    source: categoryBps !== null ? 'category' : 'policy',
  };
}

/** A whole-point price for a VND amount (rounds up, like the cost). */
export function vndToPointsCeil(amountMinor: bigint): bigint {
  return (amountMinor + POINT_VND - 1n) / POINT_VND;
}

export function pointsToVnd(points: bigint): bigint {
  return points * POINT_VND;
}
