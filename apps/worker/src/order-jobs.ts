import { resolveTxt } from 'node:dns/promises';
import { checkDomainRouting, domainTxtRecordsMatch, emitEvent, tx, writeAudit, type CnameResolver, type Db, type RoutingProbe } from '@3t/core';

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

/* ------------------------------------------------------------------ *
 * Custom-domain revalidation (audit payments L6, migration 0043).
 *
 * A domain was verified once — TXT `_3t-verify.<host>` holding a token
 * whose sha256 hex matches domains.verification_token_hash — and then
 * stayed 'verified' forever, so removing the TXT record never removed
 * service (the site-router serves exactly status='verified' rows).
 * This sweep re-resolves the record for verified domains whose last
 * re-check attempt is older than DOMAIN_RECHECK_INTERVAL_MS
 * (default 24h; main.ts calls the sweeps about once a minute while
 * idle, and the staleness filter is what sets the real cadence):
 *   - token present  → stay verified; fail state cleared,
 *     last_recheck_at stamped.
 *   - record missing or token mismatch (DEFINITIVE failure) →
 *     recheck_fail_since is stamped if unset and last_recheck_at
 *     advances; once the failure is older than the 7-day grace the
 *     domain transitions to 'verification_lost' (and stops being
 *     primary), which is what removes it from the router. The grace
 *     absorbs DNS propagation slips and registrar mishaps: a buyer who
 *     restores the record within the week never loses service.
 *   - transient DNS errors (SERVFAIL, timeout, refused, …) are
 *     INCONCLUSIVE: recheck_fail_since is never touched, so a DNS
 *     outage can never start — or extend — anyone's grace clock. But
 *     last_recheck_at IS stamped (cadence change): the sweep selects
 *     stale rows oldest-first, so an unstamped inconclusive domain
 *     would sit at the head of the queue and be re-resolved on every
 *     pass (~1/min), crowding out healthy domains behind a per-pass
 *     limit. Stamping puts the row back on the normal 24h cadence;
 *     its next check after the weather clears is conclusive as usual.
 * The token comparison mirrors the API verify route exactly: flatten
 * the TXT chunks and compare sha256(value) hex against the stored hash.
 *
 * Routing extension: when the caller passes the routing target
 * (config.customDomainTarget), a domain whose TXT still checks out must
 * ALSO still route here — CNAME chain reaching the target, or the site
 * router answering its probe on the hostname (@3t/core domain-verify).
 * A conclusive routing failure takes the same 7-day grace path with
 * audit reason 'routing'; an inconclusive verdict changes nothing.
 * ------------------------------------------------------------------ */

export type TxtResolver = (name: string) => Promise<string[][]>;

export const DOMAIN_RECHECK_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DOMAIN_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** DNS answers that prove the record is gone; everything else is weather. */
const DEFINITIVE_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND']);

export interface DomainRecheckResult {
  checked: number;
  kept: number;
  graceStarted: number;
  lost: number;
  inconclusive: number;
}

interface VerifiedDomainRow {
  id: string;
  hostname_ascii: string;
  verification_token_hash: string;
  recheck_fail_since: Date | null;
}

export async function revalidateVerifiedDomains(
  db: Db,
  opts: {
    now?: Date;
    resolveTxt?: TxtResolver;
    graceMs?: number;
    intervalMs?: number;
    limit?: number;
    /** Routing target (config.customDomainTarget). When set, a domain must
     *  ALSO still route traffic to the site router — the same combined
     *  check the API verify route runs — or it follows the exact same
     *  grace path as a lost TXT record. When unset, legacy TXT-only
     *  behaviour (used by older tests/callers). */
    target?: string;
    resolveCname?: CnameResolver;
    probe?: RoutingProbe;
  } = {},
): Promise<DomainRecheckResult> {
  const now = opts.now ?? new Date();
  const resolver: TxtResolver = opts.resolveTxt ?? ((name) => resolveTxt(name));
  const graceMs = opts.graceMs ?? DOMAIN_RECHECK_GRACE_MS;
  const intervalMs = opts.intervalMs ?? DOMAIN_RECHECK_INTERVAL_MS;
  const staleBefore = new Date(now.getTime() - intervalMs);
  const { rows } = await db.query<VerifiedDomainRow>(
    `SELECT id, hostname_ascii, verification_token_hash, recheck_fail_since FROM domains
     WHERE status = 'verified' AND (last_recheck_at IS NULL OR last_recheck_at <= $2)
     ORDER BY last_recheck_at ASC NULLS FIRST LIMIT $1`,
    [opts.limit ?? 100, staleBefore],
  );
  const result: DomainRecheckResult = { checked: 0, kept: 0, graceStarted: 0, lost: 0, inconclusive: 0 };
  for (const domain of rows) {
    let records: string[][] | null = null;
    try {
      records = await resolver(`_3t-verify.${domain.hostname_ascii}`);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (!DEFINITIVE_DNS_CODES.has(code)) {
        // Transient DNS trouble: inconclusive — the grace state is left
        // exactly as it was, but the recheck stamp advances so this row
        // re-enters on the normal 24h cadence instead of being retried
        // on every sweep pass (see the header note on starvation).
        await db.query("UPDATE domains SET last_recheck_at = $2 WHERE id = $1 AND status = 'verified'", [domain.id, now]);
        result.inconclusive++;
        continue;
      }
      records = null; // definitive: the name/record does not exist
    }
    const tokenOk = records !== null && domainTxtRecordsMatch(records, domain.verification_token_hash);
    // With a routing target configured, an intact TXT is not enough: the
    // hostname must still send traffic to the router. A conclusive routing
    // failure follows the same grace as a lost TXT record; an inconclusive
    // one (DNS weather) only advances the recheck stamp, exactly like a
    // transient TXT error above.
    let verdict: 'pass' | 'fail' | 'inconclusive' = tokenOk ? 'pass' : 'fail';
    let failReason: 'txt' | 'routing' = 'txt';
    if (tokenOk && opts.target) {
      const routing = await checkDomainRouting(domain.hostname_ascii, opts.target, { resolveCname: opts.resolveCname, probe: opts.probe });
      if (routing.ok) verdict = 'pass';
      else if (routing.conclusive) {
        verdict = 'fail';
        failReason = 'routing';
      } else verdict = 'inconclusive';
    }
    if (verdict === 'inconclusive') {
      // Same queue-fairness stamp as the transient TXT branch: the grace
      // state (recheck_fail_since, status) is untouched, last_recheck_at
      // advances to the normal 24h cadence.
      await db.query("UPDATE domains SET last_recheck_at = $2 WHERE id = $1 AND status = 'verified'", [domain.id, now]);
      result.inconclusive++;
      continue;
    }
    result.checked++;
    if (verdict === 'pass') {
      await db.query("UPDATE domains SET last_recheck_at = $2, recheck_fail_since = NULL WHERE id = $1 AND status = 'verified'", [
        domain.id,
        now,
      ]);
      result.kept++;
      continue;
    }
    // Definitive failure: no record, or no chunk hashes to the token.
    const failSince = domain.recheck_fail_since ? new Date(domain.recheck_fail_since) : now;
    if (now.getTime() - failSince.getTime() > graceMs) {
      await db.query(
        "UPDATE domains SET status = 'verification_lost', is_primary = false, last_recheck_at = $2 WHERE id = $1 AND status = 'verified'",
        [domain.id, now],
      );
      await writeAudit(db, {
        actorType: 'system',
        actorId: null,
        action: 'domain.verification_lost',
        resourceType: 'domain',
        resourceId: domain.id,
        traceId: 'worker-sweep',
        diff: { hostname_ascii: domain.hostname_ascii, fail_since: failSince.toISOString(), reason: failReason },
      });
      result.lost++;
    } else {
      await db.query(
        "UPDATE domains SET last_recheck_at = $2, recheck_fail_since = COALESCE(recheck_fail_since, $2) WHERE id = $1 AND status = 'verified'",
        [domain.id, now],
      );
      if (!domain.recheck_fail_since) result.graceStarted++;
    }
  }
  return result;
}
