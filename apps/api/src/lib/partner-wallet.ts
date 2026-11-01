import type { PoolClient } from '@3t/core';

/**
 * Partner wallet (docs/06 §11): a prepaid balance the platform deducts
 * from automatically on wallet direct sales. All mutations run inside
 * the caller's transaction with the wallet row locked, and every change
 * lands in the append-only ledger with its post-balance.
 */

type Client = PoolClient | { query: PoolClient['query'] };

export async function ensureWallet(client: Client, partnerId: string): Promise<void> {
  await client.query('INSERT INTO partner_wallets (partner_id) VALUES ($1) ON CONFLICT (partner_id) DO NOTHING', [partnerId]);
}

export async function walletBalance(client: Client, partnerId: string): Promise<bigint> {
  await ensureWallet(client, partnerId);
  const { rows } = await client.query<{ balance_minor: string }>('SELECT balance_minor::text FROM partner_wallets WHERE partner_id = $1', [partnerId]);
  return BigInt(rows[0]?.balance_minor ?? '0');
}

async function applyEntry(
  client: Client,
  partnerId: string,
  kind: 'topup' | 'sale_deduction' | 'sale_refund' | 'adjustment',
  amount: bigint,
  refType: string,
  refId: string | null,
  note: string,
): Promise<bigint> {
  await ensureWallet(client, partnerId);
  const { rows } = await client.query<{ balance_minor: string }>(
    'SELECT balance_minor::text FROM partner_wallets WHERE partner_id = $1 FOR UPDATE',
    [partnerId],
  );
  const next = BigInt(rows[0]!.balance_minor) + amount;
  if (next < 0n) throw new Error('partner_wallet_negative');
  await client.query('UPDATE partner_wallets SET balance_minor = $2 WHERE partner_id = $1', [partnerId, next.toString()]);
  await client.query(
    `INSERT INTO partner_wallet_entries (partner_id, kind, amount_minor, balance_after_minor, ref_type, ref_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [partnerId, kind, amount.toString(), next.toString(), refType, refId, note],
  );
  return next;
}

export function creditWallet(client: Client, partnerId: string, amount: bigint, kind: 'topup' | 'sale_refund' | 'adjustment', refType: string, refId: string | null, note = ''): Promise<bigint> {
  if (amount <= 0n) throw new Error('partner_wallet_amount');
  return applyEntry(client, partnerId, kind, amount, refType, refId, note);
}

export async function debitWallet(client: Client, partnerId: string, amount: bigint, kind: 'sale_deduction' | 'adjustment', refType: string, refId: string | null, note = ''): Promise<{ ok: boolean; balance: bigint }> {
  if (amount <= 0n) throw new Error('partner_wallet_amount');
  const balance = await walletBalance(client, partnerId);
  // The locked re-read inside applyEntry is authoritative; this pre-check
  // only avoids writing an entry we would have to roll back anyway.
  if (balance < amount) return { ok: false, balance };
  const next = await applyEntry(client, partnerId, kind, -amount, refType, refId, note);
  return { ok: true, balance: next };
}

/** The partner's cost for a listed charge: listed minus the policy cut. */
export function partnerCost(listedMinor: bigint, cutBps: number): bigint {
  return (listedMinor * BigInt(10000 - cutBps)) / 10000n;
}
