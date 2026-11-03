import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from '@3t/core';
import {
  BankTransferProvider,
  CassoHubProvider,
  MoMoProvider,
  VnPayProvider,
  buildCleanSiteTree,
  buildSelfhostBundle,
  buildVietQrPayload,
  parseMoMoCreateResponse,
  emitEvent,
  getSetting,
  hashToken,
  isUniqueViolation,
  loadActivePlans,
  manualTransferRef,
  randomToken,
  tx,
  usdAmountFor,
  usdAppliedRate,
  writeAudit,
  type Db,
  type NormalizedEvent,
  type PublicPlan,
} from '@3t/core';
import { requireUser } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { accrueOrderCommission, reverseOrderCommission } from '../lib/partner-ledger.ts';
import { creditWallet, POINT_VND } from '../lib/partner-wallet.ts';
import { RESERVED_SUBDOMAINS, SUBDOMAIN_RE, createSiteInTx, currentHold } from '../site-create.ts';
import { emitPartnerEvent } from '../lib/partner-webhooks.ts';
import { idempotent } from '../lib/idempotency.ts';
import { sessionRateLimit } from '../lib/rate-limit.ts';
import { openSettingSecret } from '../lib/secret-store.ts';

/**
 * Payment settings carry credentials (audit payments M2): the fields
 * listed here are stored sealed ("enc:v1:…", see secret-store) and opened
 * here, at the single read path every consumer uses. Merchant
 * identifiers (tmn_code, partner_code, access_key) and buyer-facing
 * account details are not signing secrets and stay readable as stored.
 * Legacy plaintext values open unchanged until the next settings save.
 */
const PAYMENT_SECRET_FIELDS: Record<string, string[]> = {
  'payment.bank_transfer': ['hub_api_key'],
  'payment.vnpay': ['secret_key'],
  'payment.momo': ['secret_key'],
};

async function getPaymentSetting(db: Db, key: string, secretKey: string): Promise<Record<string, unknown> | null> {
  const raw = (await getSetting(db, key).catch(() => null)) as Record<string, unknown> | null;
  if (raw) {
    for (const field of PAYMENT_SECRET_FIELDS[key] ?? []) {
      if (typeof raw[field] === 'string') raw[field] = openSettingSecret(secretKey, raw[field] as string);
    }
  }
  return raw;
}
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUOTE_TTL_MINUTES = 15;

function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

interface QuoteLine {
  label: string;
  interval: 'one_time' | 'monthly' | 'yearly';
  amount_minor: string;
}

/** Owner-configured bank transfer (settings key 'payment.bank_transfer'). */
export interface BankTransferSettings {
  enabled: boolean;
  bank_name: string;
  /** NAPAS bank BIN (6 digits). When set, checkout shows a VietQR code. */
  bank_bin: string;
  account_number: string;
  account_holder: string;
  hub_api_key: string;
}

export async function loadBankTransferSettings(db: Db, secretKey: string): Promise<BankTransferSettings> {
  // A missing settings row means "not configured yet", never a 500 on checkout.
  const raw = (await getPaymentSetting(db, 'payment.bank_transfer', secretKey)) as Partial<BankTransferSettings> | null;
  return {
    enabled: raw?.enabled === true,
    bank_name: typeof raw?.bank_name === 'string' ? raw.bank_name : '',
    bank_bin: typeof raw?.bank_bin === 'string' ? raw.bank_bin : '',
    account_number: typeof raw?.account_number === 'string' ? raw.account_number : '',
    account_holder: typeof raw?.account_holder === 'string' ? raw.account_holder : '',
    hub_api_key: typeof raw?.hub_api_key === 'string' ? raw.hub_api_key : '',
  };
}

/** Bank transfer can be offered only when the owner enabled it AND filled the account in. */
export function bankTransferAvailable(s: BankTransferSettings): boolean {
  return s.enabled && s.bank_name.trim() !== '' && s.account_number.trim() !== '' && s.account_holder.trim() !== '';
}

/** Owner-configured VNPay merchant (settings key 'payment.vnpay'). */
export interface VnPaySettings {
  enabled: boolean;
  tmn_code: string;
  secret_key: string;
  sandbox: boolean;
}

export async function loadVnPaySettings(db: Db, secretKey: string): Promise<VnPaySettings> {
  const raw = (await getPaymentSetting(db, 'payment.vnpay', secretKey)) as Partial<VnPaySettings> | null;
  return {
    enabled: raw?.enabled === true,
    tmn_code: typeof raw?.tmn_code === 'string' ? raw.tmn_code : '',
    secret_key: typeof raw?.secret_key === 'string' ? raw.secret_key : '',
    sandbox: raw?.sandbox !== false,
  };
}

export function vnPayAvailable(s: VnPaySettings): boolean {
  return s.enabled && s.tmn_code.trim() !== '' && s.secret_key !== '';
}

/** Owner-configured MoMo merchant (settings key 'payment.momo'). */
export interface MoMoSettings {
  enabled: boolean;
  partner_code: string;
  access_key: string;
  secret_key: string;
  sandbox: boolean;
}

export async function loadMoMoSettings(db: Db, secretKey: string): Promise<MoMoSettings> {
  const raw = (await getPaymentSetting(db, 'payment.momo', secretKey)) as Partial<MoMoSettings> | null;
  return {
    enabled: raw?.enabled === true,
    partner_code: typeof raw?.partner_code === 'string' ? raw.partner_code : '',
    access_key: typeof raw?.access_key === 'string' ? raw.access_key : '',
    secret_key: typeof raw?.secret_key === 'string' ? raw.secret_key : '',
    sandbox: raw?.sandbox !== false,
  };
}

export function moMoAvailable(s: MoMoSettings): boolean {
  return s.enabled && s.partner_code.trim() !== '' && s.access_key.trim() !== '' && s.secret_key !== '';
}

/** Owner-configured PayPal receiving account (settings key 'payment.paypal').
 *  Settlement is confirmed by staff in reconciliation once the money lands —
 *  PayPal has no hub reporting into the platform, so this method is manual
 *  by design; the buyer writes the per-order reference in the PayPal note. */
export interface PayPalSettings {
  enabled: boolean;
  email: string;
  holder: string;
}

export async function loadPayPalSettings(db: Db): Promise<PayPalSettings> {
  const raw = (await getSetting(db, 'payment.paypal').catch(() => null)) as Partial<PayPalSettings> | null;
  return {
    enabled: raw?.enabled === true,
    email: typeof raw?.email === 'string' ? raw.email : '',
    holder: typeof raw?.holder === 'string' ? raw.holder : '',
  };
}

export function payPalAvailable(s: PayPalSettings): boolean {
  return s.enabled && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim());
}

/** Owner-configured USD bank account (settings key 'payment.usd_transfer').
 *  The buyer wires USD from abroad; the quote uses the APPLIED rate frozen
 *  into the attempt's instructions, and staff confirm settlement in
 *  reconciliation. SWIFT is optional (some accounts receive via an
 *  intermediary without one), the rate is not: no rate, no quote.
 *  The stored `usd_rate` is the BASE rate, pegged by the owner to the
 *  State Bank of Vietnam's daily central rate (`base_rate_date` records
 *  the day it was last set); `usd_rate` on this interface is the APPLIED
 *  rate = base adjusted by `fee_percent` (may be negative). */
export interface UsdTransferSettings {
  enabled: boolean;
  bank_name: string;
  account_number: string;
  account_holder: string;
  swift_code: string;
  /** Applied rate (VND per 1 USD) quoted to buyers: base + fee. */
  usd_rate: number;
  base_rate: number;
  fee_percent: number;
  base_rate_date: string;
}

export async function loadUsdTransferSettings(db: Db): Promise<UsdTransferSettings> {
  const raw = (await getSetting(db, 'payment.usd_transfer').catch(() => null)) as {
    enabled?: boolean; bank_name?: string; account_number?: string; account_holder?: string;
    swift_code?: string; usd_rate?: number; fee_percent?: number; base_rate_date?: string;
  } | null;
  const base = typeof raw?.usd_rate === 'number' && Number.isFinite(raw.usd_rate) ? raw.usd_rate : 0;
  const fee = typeof raw?.fee_percent === 'number' && Number.isFinite(raw.fee_percent) ? raw.fee_percent : 0;
  return {
    enabled: raw?.enabled === true,
    bank_name: typeof raw?.bank_name === 'string' ? raw.bank_name : '',
    account_number: typeof raw?.account_number === 'string' ? raw.account_number : '',
    account_holder: typeof raw?.account_holder === 'string' ? raw.account_holder : '',
    swift_code: typeof raw?.swift_code === 'string' ? raw.swift_code : '',
    usd_rate: usdAppliedRate(base, fee),
    base_rate: base,
    fee_percent: fee,
    base_rate_date: typeof raw?.base_rate_date === 'string' ? raw.base_rate_date : '',
  };
}

export function usdTransferAvailable(s: UsdTransferSettings): boolean {
  return s.enabled && s.bank_name.trim() !== '' && s.account_number.trim() !== '' && s.account_holder.trim() !== '' && s.usd_rate > 0;
}

/**
 * Compute what a buyer first pays for a plan from its current prices (never from the client):
 * self-host is a single one-time fee; hosting is an optional setup fee plus the first period.
 */
export function computeCharge(plan: PublicPlan, billingInterval?: 'monthly' | 'yearly', storage?: { perGb: number; gb: number; months: number }): { subtotal: bigint; lines: QuoteLine[] } {
  const oneTime = plan.prices.find((p) => p.interval === 'one_time');
  const recurring = billingInterval
    ? plan.prices.find((p) => p.interval === billingInterval)
    : plan.prices.find((p) => p.interval === 'monthly' || p.interval === 'yearly');
  const lines: QuoteLine[] = [];
  let subtotal = 0n;
  if (plan.deployment_mode === 'selfhost') {
    if (!oneTime) throw errors.conflict('plan.not_purchasable');
    lines.push({ label: plan.code, interval: 'one_time', amount_minor: oneTime.amount_minor });
    subtotal = BigInt(oneTime.amount_minor);
  } else if (storage) {
    // Storage-priced hosting (v33: the owner sets ONE per-GB monthly
    // rate): the recurring charge is rate x GB x months — a yearly pick
    // is simply 12 months multiplied automatically. The plan's flat
    // recurring price does not apply while a rate is set.
    const period = billingInterval ?? (plan.prices.some((p) => p.interval === 'monthly') ? 'monthly' : 'yearly');
    if (oneTime) {
      lines.push({ label: `${plan.code}:setup`, interval: 'one_time', amount_minor: oneTime.amount_minor });
      subtotal += BigInt(oneTime.amount_minor);
    }
    const amount = BigInt(Math.trunc(storage.perGb)) * BigInt(storage.gb) * BigInt(storage.months);
    lines.push({ label: `${plan.code}:first_period`, interval: period, amount_minor: amount.toString() });
    subtotal += amount;
  } else {
    if (!recurring) throw errors.conflict(billingInterval ? 'plan.interval_unavailable' : 'plan.not_purchasable');
    if (oneTime) {
      lines.push({ label: `${plan.code}:setup`, interval: 'one_time', amount_minor: oneTime.amount_minor });
      subtotal += BigInt(oneTime.amount_minor);
    }
    lines.push({ label: `${plan.code}:first_period`, interval: recurring.interval, amount_minor: recurring.amount_minor });
    subtotal += BigInt(recurring.amount_minor);
  }
  return { subtotal, lines };
}

/** A hosted purchase's site wish, captured at quote time: the buyer picked
 *  the subdomain (and site name) while buying, so fulfilment can create
 *  the site the moment the order is paid. */
export interface SiteRequest { subdomain: string; display_name: string; locale: 'vi' | 'en'; domain_interval?: 'once' | 'monthly' | 'yearly' }

interface SubdomainFeeSetting { amount_minor?: number | null; period?: string }

/** The domain package's price line for a buyer-chosen period, from the
 *  OWNER's fee settings only. Returns null when no fee is configured. */
export function domainFeeLine(feeRaw: SubdomainFeeSetting | null, wantYearly: boolean): { line: QuoteLine; interval: 'once' | 'monthly' | 'yearly' } | null {
  if (!feeRaw || typeof feeRaw.amount_minor !== 'number' || feeRaw.amount_minor <= 0) return null;
  if (feeRaw.period === 'monthly' && wantYearly) {
    // v33: one owner-set monthly fee; a yearly pick is 12 months
    // multiplied automatically — there is no separate yearly price.
    return { line: { label: 'subdomain_fee', interval: 'yearly', amount_minor: String(Math.trunc(feeRaw.amount_minor) * 12) }, interval: 'yearly' };
  }
  if (feeRaw.period === 'monthly') {
    return { line: { label: 'subdomain_fee', interval: 'monthly', amount_minor: String(Math.trunc(feeRaw.amount_minor)) }, interval: 'monthly' };
  }
  return { line: { label: 'subdomain_fee', interval: 'one_time', amount_minor: String(Math.trunc(feeRaw.amount_minor)) }, interval: 'once' };
}

/** Extend a site's domain paid-through horizon by one bought period. */
export async function applyDomainPaidPeriod(client: PoolClient, siteId: string, interval: 'once' | 'monthly' | 'yearly'): Promise<void> {
  await client.query(
    `UPDATE sites SET domain_paid_until = CASE
       WHEN $2 = 'yearly' THEN GREATEST(COALESCE(domain_paid_until, now()), now()) + interval '1 year'
       WHEN $2 = 'monthly' THEN GREATEST(COALESCE(domain_paid_until, now()), now()) + interval '1 month'
       ELSE '9999-12-31T00:00:00Z'::timestamptz
     END WHERE id = $1`,
    [siteId, interval],
  );
}

/**
 * Move an awaiting_payment order past its payment window to 'expired':
 * pending attempts expire with it and the transition is audited, so
 * "cancelled / not received" is always a recorded state, never limbo.
 * Caller holds the transaction; returns true when it transitioned.
 */
export async function expireStaleOrder(client: PoolClient, orderId: string, traceId: string): Promise<boolean> {
  const { rows } = await client.query<{ status: string; payment_window_expires_at: Date | null }>(
    'SELECT status, payment_window_expires_at FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  const o = rows[0];
  if (!o || o.status !== 'awaiting_payment' || !o.payment_window_expires_at || o.payment_window_expires_at > new Date()) return false;
  await client.query("UPDATE orders SET status = 'expired', row_version = row_version + 1 WHERE id = $1", [orderId]);
  await client.query("UPDATE payment_attempts SET status = 'expired' WHERE order_id = $1 AND status = 'pending'", [orderId]);
  await emitEvent(client, 'order.expired', 'order', orderId, { order_id: orderId, reason: 'payment_window' });
  await writeAudit(client, { actorType: 'system', actorId: null, action: 'order.expired', resourceType: 'order', resourceId: orderId, traceId, diff: { reason: 'payment_window' } });
  return true;
}

/**
 * Fulfil a paid order: one entitlement per order item (unique per item, invariant §6.3),
 * order marked paid, outbox event + audit. Callers must already hold the order row lock
 * and have decided the order may move to paid.
 */
export async function fulfillOrder(client: PoolClient, orderId: string, buyerId: string, traceId: string): Promise<void> {
  const items = await client.query<{ id: string; template_id: string; version_id: string; deployment_mode: string; snapshot_json: { updates_months?: number; instance_limit?: number; site_request?: SiteRequest; installation?: boolean; domain_fee_paid?: boolean; storage_gb?: number } }>(
    'SELECT id, template_id, version_id, deployment_mode, snapshot_json FROM order_items WHERE order_id = $1',
    [orderId],
  );
  for (const item of items.rows) {
    const updatesMonths = item.snapshot_json.updates_months ?? null;
    const instanceLimit = item.snapshot_json.instance_limit ?? 1;
    await client.query(
      `INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit, updates_until, runtime_expires_at, storage_gb)
       VALUES ($1, $2, $3, $4, $5, 'active', $6,
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(months => $7::int) END,
               NULL, $8)
       ON CONFLICT (order_item_id) DO NOTHING`,
      [item.id, buyerId, item.template_id, item.version_id, item.deployment_mode, instanceLimit, updatesMonths, item.snapshot_json.storage_gb ?? 1],
    );
    // The separate installation/configuration package: no entitlement —
    // it is work for the team, tracked as a service task the buyer can
    // follow on their order and staff clear from the operations queue.
    if (item.snapshot_json.installation) {
      await client.query(
        "INSERT INTO service_tasks (order_id, buyer_id, kind) VALUES ($1, $2, 'installation')",
        [orderId, buyerId],
      );
    }
    // Hosted purchase that already chose its domain at checkout: create
    // the site right away so the buyer just logs in and it runs.
    // Best-effort by design \u2014 a name lost in the meantime (or any other
    // create conflict) must never claw back a paid entitlement; the buyer
    // then picks a name in the setup wizard instead. The SAVEPOINT keeps
    // a failed attempt out of the fulfilment transaction.
    const siteRequest = item.snapshot_json.site_request;
    if (item.deployment_mode === 'hosted' && siteRequest) {
      const ent = await client.query<{ id: string }>('SELECT id FROM entitlements WHERE order_item_id = $1', [item.id]);
      const entitlementId = ent.rows[0]?.id;
      if (entitlementId) {
        await client.query('SAVEPOINT auto_site');
        try {
          const created = await createSiteInTx(client, {
            ownerId: buyerId,
            entitlementId,
            displayName: siteRequest.display_name,
            subdomain: siteRequest.subdomain,
            defaultLocale: siteRequest.locale,
            traceId,
            actorType: 'system',
            actorId: null,
            via: 'checkout',
          });
          await client.query('RELEASE SAVEPOINT auto_site');
          if (item.snapshot_json.domain_fee_paid) {
            await applyDomainPaidPeriod(client, created.siteId, siteRequest.domain_interval ?? 'once');
          }
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT auto_site');
          await client.query('RELEASE SAVEPOINT auto_site');
        }
      }
    }
  }
  // An order with no items is the standalone domain package: extend the
  // named site's paid-through horizon by the bought period.
  if (items.rows.length === 0) {
    const q = await client.query<{ snapshot_json: { kind?: string; site_id?: string; site_request?: SiteRequest } }>(
      'SELECT q.snapshot_json FROM quotes q JOIN orders o ON o.quote_id = q.id WHERE o.id = $1',
      [orderId],
    );
    const qs = q.rows[0]?.snapshot_json;
    if (qs?.kind === 'domain_package' && qs.site_id) {
      await applyDomainPaidPeriod(client, qs.site_id, qs.site_request?.domain_interval ?? 'once');
    }
  }
  await client.query("UPDATE orders SET status = 'paid', paid_at = now(), row_version = row_version + 1 WHERE id = $1", [orderId]);
  await emitEvent(client, 'order.paid', 'order', orderId, { order_id: orderId, buyer_id: buyerId });
  // Partner commission accrues at settlement from the attribution snapshot (M6, docs/06 §7).
  await accrueOrderCommission(client, orderId);
  const attribution = await client.query<{ partner_id: string }>('SELECT partner_id FROM attributions WHERE order_id = $1', [orderId]);
  if (attribution.rows[0]) {
    const session = await client.query<{ external_reference: string }>(
      'SELECT external_reference FROM checkout_sessions WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId],
    );
    await emitPartnerEvent(client, attribution.rows[0]!.partner_id, {
      type: 'order.paid',
      data: { order_id: orderId, external_reference: session.rows[0]?.external_reference ?? null, payment_status: 'paid' },
    });
  }
  await writeAudit(client, { actorType: 'system', actorId: null, action: 'order.paid', resourceType: 'order', resourceId: orderId, traceId });
}

/** Recompute an order's refund-derived status from its confirmed refunds (AT-56). */
export async function recomputeOrderRefundStatus(client: PoolClient, orderId: string): Promise<string> {
  const order = await client.query<{ status: string; total_minor: string }>(
    "SELECT status, total_minor::text FROM orders WHERE id = $1 FOR UPDATE",
    [orderId],
  );
  const o = order.rows[0]!;
  if (o.status !== 'paid' && o.status !== 'refund_pending' && o.status !== 'partially_refunded' && o.status !== 'refunded') return o.status;
  const sums = await client.query<{ confirmed: string; active: string }>(
    `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status = 'confirmed'), 0)::text AS confirmed,
            COUNT(*) FILTER (WHERE status IN ('requested', 'pending'))::text AS active
     FROM refunds WHERE order_id = $1`,
    [orderId],
  );
  const confirmed = BigInt(sums.rows[0]!.confirmed);
  const total = BigInt(o.total_minor);
  let next: string;
  if (confirmed >= total && total > 0n) next = 'refunded';
  else if (confirmed > 0n) next = 'partially_refunded';
  else if (sums.rows[0]!.active !== '0') next = 'refund_pending';
  else next = 'paid';
  if (next !== o.status) {
    await client.query('UPDATE orders SET status = $2, row_version = row_version + 1 WHERE id = $1', [orderId, next]);
    if (next === 'refunded') {
      // Revoke only this order's entitlements (one per order item, invariant §6.3).
      await client.query(
        `UPDATE entitlements SET status = 'revoked', row_version = row_version + 1
         WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1) AND status = 'active'`,
        [orderId],
      );
      // A full refund also tears down what the money bought (audit
      // payments H3): sites created from this order's entitlements are
      // suspended in the same transaction — the site router answers
      // 403 for suspended sites, and the update gate refuses because
      // the entitlement is no longer active. One-way by design, like
      // the entitlement revoke above: a later un-refund does not
      // silently resurrect a torn-down site.
      await client.query(
        `UPDATE sites SET status = 'suspended'
         WHERE entitlement_id IN (
           SELECT id FROM entitlements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)
         ) AND status NOT IN ('suspended', 'delete_scheduled', 'purged')`,
        [orderId],
      );
    }
  }
  return next;
}

/**
 * Process a verified provider refund event (AT-56): dedupe by provider event id, and apply a
 * confirmed refund exactly once. A failed event only marks the refund failed; a later confirmed
 * event still applies. Full refunds revoke the order's entitlements, once.
 */
export async function processRefundEvent(db: Db, provider: string, rawBody: string, event: { providerEventId: string; refundRef: string; status: 'confirmed' | 'failed'; amountMinor: string; currency: string }): Promise<'processed' | 'duplicate' | 'ignored'> {
  const bodyHash = hashToken(rawBody).toString('hex');
  return tx(db, async (client) => {
    const inserted = await client.query(
      `INSERT INTO refund_events (provider, provider_event_id, refund_id, raw_body_hash)
       VALUES ($1, $2, NULL, $3) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [provider, event.providerEventId, bodyHash],
    );
    if (inserted.rowCount === 0) return 'duplicate';
    const found = await client.query<{ id: string; order_id: string; status: string; amount_minor: string; currency: string }>(
      'SELECT id, order_id, status, amount_minor::text, currency FROM refunds WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
      [provider, event.refundRef],
    );
    const refund = found.rows[0];
    if (!refund) {
      await client.query("UPDATE refund_events SET processing_status = 'ignored' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'ignored';
    }
    await client.query('UPDATE refund_events SET refund_id = $3, processing_status = $4 WHERE provider = $1 AND provider_event_id = $2', [provider, event.providerEventId, refund.id, 'processed']);
    if (refund.status === 'confirmed') return 'processed'; // already applied; never reverse twice
    if (event.status === 'failed') {
      if (refund.status === 'pending') await client.query("UPDATE refunds SET status = 'failed' WHERE id = $1", [refund.id]);
      await writeAudit(client, { actorType: 'system', actorId: null, action: 'refund.failed', resourceType: 'refund', resourceId: refund.id, traceId: event.providerEventId });
      await recomputeOrderRefundStatus(client, refund.order_id);
      return 'processed';
    }
    // Confirmed: amount/currency must match the approved refund, else leave for reconciliation.
    if (event.currency !== refund.currency || BigInt(event.amountMinor) !== BigInt(refund.amount_minor)) {
      await client.query("UPDATE refund_events SET processing_status = 'ignored' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'ignored';
    }
    if (refund.status !== 'pending') return 'processed'; // requested/rejected refunds are not settled by the provider
    await client.query("UPDATE refunds SET status = 'confirmed' WHERE id = $1", [refund.id]);
    const orderStatus = await recomputeOrderRefundStatus(client, refund.order_id);
    await emitEvent(client, orderStatus === 'refunded' ? 'order.refunded' : 'order.partially_refunded', 'order', refund.order_id, { order_id: refund.order_id, refund_id: refund.id });
    await writeAudit(client, { actorType: 'system', actorId: null, action: 'refund.confirmed', resourceType: 'refund', resourceId: refund.id, traceId: event.providerEventId });
    // Partner reversal keeps net commission at zero on full refund (AT-38/AT-39).
    await reverseOrderCommission(client, refund.order_id);
    const refundAttribution = await client.query<{ partner_id: string }>('SELECT partner_id FROM attributions WHERE order_id = $1', [refund.order_id]);
    if (refundAttribution.rows[0]) {
      await emitPartnerEvent(client, refundAttribution.rows[0]!.partner_id, {
        type: 'refund.settled',
        data: { order_id: refund.order_id, refund_id: refund.id, amount_minor: refund.amount_minor, currency: refund.currency },
      });
    }
    return 'processed';
  });
}

/**
 * Process a verified payment event (docs/08 §1): dedupe, check amount/currency, and on settlement
 * create one entitlement per order item and mark the order paid — all idempotent. A duplicate or
 * out-of-order event never regresses a paid order or duplicates an entitlement (invariant §6.3).
 */
export async function processPaymentEvent(db: Db, provider: string, rawBody: string, event: NormalizedEvent): Promise<'processed' | 'duplicate' | 'ignored' | 'needs_reconciliation'> {
  const bodyHash = hashToken(rawBody).toString('hex');
  return tx(db, async (client) => {
    const inserted = await client.query(
      `INSERT INTO payment_events (provider, provider_event_id, raw_body_hash, verified_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [provider, event.providerEventId, bodyHash],
    );
    if (inserted.rowCount === 0) return 'duplicate';

    const attempt = await client.query<{ id: string; order_id: string; amount_minor: string; currency: string }>(
      'SELECT id, order_id, amount_minor::text, currency FROM payment_attempts WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
      [provider, event.providerRef],
    );
    const pa = attempt.rows[0];
    if (!pa) {
      // Partner wallet top-ups ride the same bank webhooks: the WT content
      // code names a pending topup, and the received amount credits the
      // partner's wallet directly (docs/06 §11).
      if (provider === 'bank_transfer' && event.status === 'settled' && BigInt(event.amountMinor) > 0n) {
        const topup = await client.query<{ id: string; partner_id: string; amount_points: string; paid_amount_minor: string | null }>(
          "SELECT id, partner_id, amount_points::text, paid_amount_minor::text FROM partner_topups WHERE code = $1 AND status = 'pending' FOR UPDATE",
          [event.providerRef],
        );
        if (topup.rows[0]) {
          const t = topup.rows[0]!;
          // Top-ups ACCUMULATE (audit payments M1): a bank transfer can
          // arrive in parts. paid_amount_minor grows with every settled
          // event; whole points are credited incrementally (never more
          // than the requested amount_points); the top-up closes only
          // once the full requested amount has arrived — an underpayment
          // no longer closes it 'paid' forever, and an overpayment is
          // capped at the request and flagged for reconciliation instead
          // of silently minting extra points.
          const targetMinor = BigInt(t.amount_points) * POINT_VND;
          const alreadyMinor = BigInt(t.paid_amount_minor ?? '0');
          const receivedMinor = alreadyMinor + BigInt(event.amountMinor);
          const creditableMinor = receivedMinor < targetMinor ? receivedMinor : targetMinor;
          const credit = creditableMinor / POINT_VND - alreadyMinor / POINT_VND;
          if (credit > 0n) {
            await creditWallet(client, t.partner_id, credit, 'topup', 'partner_topup', t.id, event.providerRef);
          }
          if (receivedMinor >= targetMinor) {
            await client.query("UPDATE partner_topups SET status = 'paid', paid_amount_minor = $2, paid_at = now() WHERE id = $1", [t.id, receivedMinor.toString()]);
            if (receivedMinor > targetMinor) {
              await client.query("UPDATE payment_events SET processing_status = 'needs_reconciliation' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
              return 'needs_reconciliation';
            }
          } else {
            await client.query('UPDATE partner_topups SET paid_amount_minor = $2 WHERE id = $1', [t.id, receivedMinor.toString()]);
          }
          await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
          return 'processed';
        }
      }
      await client.query("UPDATE payment_events SET processing_status = 'ignored' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'ignored';
    }
    await client.query('UPDATE payment_events SET order_id = $3 WHERE provider = $1 AND provider_event_id = $2', [provider, event.providerEventId, pa.order_id]);

    if (event.status !== 'settled') {
      // A late/out-of-order failure report must never overwrite a settled
      // attempt (audit payments L2): only a non-final attempt (created /
      // pending) may move to 'failed'; a settled attempt — and the paid
      // order behind it — stays exactly as recorded.
      await client.query("UPDATE payment_attempts SET status = 'failed' WHERE id = $1 AND status IN ('pending', 'created')", [pa.id]);
      await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'processed';
    }

    const order = await client.query<{ id: string; status: string; total_minor: string; currency: string; buyer_id: string }>(
      'SELECT id, status, total_minor::text, currency, buyer_id FROM orders WHERE id = $1 FOR UPDATE',
      [pa.order_id],
    );
    const o = order.rows[0]!;
    // Amount/currency must match the obligation; a mismatch goes to reconciliation, never auto-fulfilled.
    if (event.currency !== o.currency || BigInt(event.amountMinor) !== BigInt(o.total_minor)) {
      await client.query("UPDATE payment_attempts SET status = 'settled', settled_at = now() WHERE id = $1", [pa.id]);
      await client.query("UPDATE orders SET status = 'needs_reconciliation', row_version = row_version + 1 WHERE id = $1 AND status IN ('awaiting_payment', 'expired')", [o.id]);
      await client.query("UPDATE payment_events SET processing_status = 'needs_reconciliation' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'needs_reconciliation';
    }

    await client.query("UPDATE payment_attempts SET status = 'settled', settled_at = now() WHERE id = $1", [pa.id]);
    // Money for an EXPIRED order: an admin's manual confirmation is
    // authoritative and revives the order into fulfilment; an automatic
    // hub/IPN report goes to reconciliation instead \u2014 a person decides
    // whether late money fulfils or is refunded, never a silent drop.
    const isManualConfirm = event.providerEventId.startsWith('manual_');
    if (o.status === 'expired' && !isManualConfirm) {
      await client.query("UPDATE orders SET status = 'needs_reconciliation', row_version = row_version + 1 WHERE id = $1 AND status = 'expired'", [o.id]);
      await client.query("UPDATE payment_events SET processing_status = 'needs_reconciliation' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'needs_reconciliation';
    }
    // A late event on an already-paid order is acknowledged without regressing state.
    if (o.status !== 'awaiting_payment' && o.status !== 'expired') {
      await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'processed';
    }

    await fulfillOrder(client, o.id, o.buyer_id, event.providerEventId);
    await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
    return 'processed';
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact raw request bytes, captured by the webhook routes (L-01). */
    rawBody?: string;
  }
}

/**
 * Capture the exact raw request bytes before Fastify's JSON parser runs
 * (audit code L-01): webhook HMACs must be verified over the bytes the
 * sender actually signed, not over a re-serialisation of the parsed JSON
 * (duplicate keys, unicode escapes and number formatting do not survive
 * a parse → stringify round-trip). The buffered bytes are replayed into
 * the normal parser, so `request.body` behaves exactly as before for
 * every handler; only the `raw` string used for verification changes.
 */
async function captureRawBody(request: FastifyRequest, _reply: FastifyReply, payload: Readable): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const raw = Buffer.concat(chunks);
  request.rawBody = raw.toString('utf8');
  return Readable.from([raw]);
}

/** The raw bytes for a webhook request: the captured bytes when the
 *  route captured them, else the legacy fallback (string body as-is, or
 *  a re-serialisation) for paths that never signed over a body. */
function rawBodyOf(request: FastifyRequest): string {
  if (typeof request.rawBody === 'string') return request.rawBody;
  return typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
}

export async function commerceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, store, payment } = app.deps;

  async function loadPlanForPurchase(templateId: string, planId: string): Promise<{ plan: PublicPlan; versionId: string } | null> {
    const { rows } = await db.query<{ published_version_id: string | null }>(
      "SELECT published_version_id FROM templates WHERE id = $1 AND status = 'published' AND NOT hidden",
      [templateId],
    );
    if (!rows[0]?.published_version_id) return null;
    const plans = await loadActivePlans(db, templateId, config.currency);
    const plan = plans.find((p) => p.id === planId);
    return plan ? { plan, versionId: rows[0].published_version_id } : null;
  }

  // POST /quotes — backend prices the plan; the quote is bound to the buyer and expires.
  app.post<{ Body: { plan_id: string; template_id: string; billing_interval?: 'monthly' | 'yearly'; installation?: boolean; upgrade_entitlement_id?: string; storage_gb?: number; site_request?: { subdomain: string; display_name: string; locale?: 'vi' | 'en'; domain_interval?: 'monthly' | 'yearly' } } }>(
    '/quotes',
    // Each quote writes a row and can hold a subdomain: cap free-account
    // quote spam (audit code M-05) well above real checkout behaviour.
    { config: sessionRateLimit(120), schema: { body: { type: 'object', additionalProperties: false, required: ['plan_id', 'template_id'], properties: { plan_id: { type: 'string', pattern: UUID.source }, template_id: { type: 'string', pattern: UUID.source }, site_request: { type: 'object', additionalProperties: false, required: ['subdomain', 'display_name'], properties: { subdomain: { type: 'string', minLength: 3, maxLength: 40 }, display_name: { type: 'string', minLength: 1, maxLength: 120 }, locale: { enum: ['vi', 'en'] }, domain_interval: { enum: ['monthly', 'yearly'] } } }, billing_interval: { enum: ['monthly', 'yearly'] }, installation: { type: 'boolean' }, upgrade_entitlement_id: { type: 'string', pattern: UUID.source }, storage_gb: { type: 'integer', minimum: 1, maximum: 100 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const found = await loadPlanForPurchase(request.body.template_id, request.body.plan_id);
      if (!found) throw errors.notFound();
      // Packages stay separate (owner rule): the web itself, hosting
      // (monthly OR yearly at the buyer's choice), the domain, and the
      // installation service are distinct lines — never silently bundled.
      let upgradeEntitlementId: string | null = null;
      if (request.body.upgrade_entitlement_id) {
        // Standalone hosting: only for a web the buyer already owns, and
        // only against that template's hosted plan.
        if (found.plan.deployment_mode !== 'hosted') throw errors.validation([{ field: 'upgrade_entitlement_id', code: 'hosted_only' }]);
        const ent = await db.query<{ user_id: string; template_id: string; mode: string; status: string }>(
          'SELECT user_id, template_id, mode, status FROM entitlements WHERE id = $1',
          [request.body.upgrade_entitlement_id],
        );
        const e = ent.rows[0];
        if (!e || e.user_id !== auth.userId || e.template_id !== request.body.template_id || e.mode !== 'selfhost' || e.status !== 'active') {
          throw errors.validation([{ field: 'upgrade_entitlement_id', code: 'invalid' }]);
        }
        upgradeEntitlementId = request.body.upgrade_entitlement_id;
      }
      const billingInterval = request.body.billing_interval;
      if (billingInterval && found.plan.deployment_mode !== 'hosted') {
        throw errors.validation([{ field: 'billing_interval', code: 'hosted_only' }]);
      }
      // Storage-priced hosting: the owner sets ONE per-GB monthly rate;
      // the buyer picks GB and a period, and the total multiplies
      // automatically (yearly = 12 months). Asking for more than 1 GB
      // without a rate is refused, never silently charged flat.
      const storageGb = request.body.storage_gb ?? 1;
      if (request.body.storage_gb !== undefined && found.plan.deployment_mode !== 'hosted') {
        throw errors.validation([{ field: 'storage_gb', code: 'hosted_only' }]);
      }
      let storage: { perGb: number; gb: number; months: number } | undefined;
      let storageRatePerGb: number | null = null;
      if (found.plan.deployment_mode === 'hosted') {
        const rates = (await getSetting(db, 'hosting.storage_price').catch(() => null)) as { per_gb_minor?: number | null; monthly_per_gb?: number | null } | null;
        const period = billingInterval ?? (found.plan.prices.some((pr) => pr.interval === 'monthly') ? 'monthly' : 'yearly');
        // Legacy fallback: values saved before v33 stored the monthly
        // rate under monthly_per_gb; per_gb_minor is the canonical key.
        const rate = rates?.per_gb_minor ?? rates?.monthly_per_gb;
        if (typeof rate === 'number' && rate > 0) {
          storage = { perGb: rate, gb: storageGb, months: period === 'yearly' ? 12 : 1 };
          storageRatePerGb = rate;
        } else if (storageGb > 1) {
          throw errors.validation([{ field: 'storage_gb', code: 'rate_unset' }]);
        }
      }
      const charge = computeCharge(found.plan, billingInterval, storage);
      const lines: QuoteLine[] = [...charge.lines];
      let subtotal = charge.subtotal;
      // Hosted buyers may choose their subdomain while buying (owner rule
      // 2026-11-01): the name is held for them through checkout, the
      // owner-set subdomain fee joins the SAME total when configured, and
      // fulfilment creates the site the moment the order is paid.
      let siteRequest: SiteRequest | null = null;
      if (request.body.site_request) {
        if (found.plan.deployment_mode !== 'hosted') throw errors.validation([{ field: 'site_request', code: 'hosted_only' }]);
        const subdomain = request.body.site_request.subdomain.trim().toLowerCase();
        const displayName = request.body.site_request.display_name.trim();
        if (!SUBDOMAIN_RE.test(subdomain) || RESERVED_SUBDOMAINS.has(subdomain)) throw errors.validation([{ field: 'site_request.subdomain', code: 'invalid' }]);
        if (!displayName) throw errors.validation([{ field: 'site_request.display_name', code: 'required' }]);
        siteRequest = { subdomain, display_name: displayName, locale: request.body.site_request.locale === 'en' ? 'en' : 'vi' };
        const ttlRaw = (await getSetting(db, 'subdomain.reservation').catch(() => null)) as { ttl_minutes?: number } | null;
        const ttl = Number.isInteger(ttlRaw?.ttl_minutes) && ttlRaw!.ttl_minutes! >= 1 && ttlRaw!.ttl_minutes! <= 1440 ? ttlRaw!.ttl_minutes! : 15;
        await tx(db, async (client) => {
          const taken = await client.query('SELECT 1 FROM sites WHERE subdomain = $1 LIMIT 1', [subdomain]);
          if (taken.rows.length > 0) throw errors.conflict('site.subdomain_taken');
          const hold = await currentHold(client, subdomain);
          if (hold && hold.user_id !== auth.userId) throw errors.conflict('site.subdomain_held');
          if (hold) {
            await client.query('UPDATE subdomain_reservations SET expires_at = now() + make_interval(mins => $2) WHERE id = $1', [hold.id, ttl]);
          } else {
            try {
              await client.query(
                'INSERT INTO subdomain_reservations (subdomain, user_id, entitlement_id, expires_at) VALUES ($1, $2, NULL, now() + make_interval(mins => $3))',
                [subdomain, auth.userId, ttl],
              );
            } catch (error) {
              if (isUniqueViolation(error)) throw errors.conflict('site.subdomain_held');
              throw error;
            }
          }
        });
        const feeRaw = (await getSetting(db, 'subdomain.fee').catch(() => null)) as SubdomainFeeSetting | null;
        // The domain is its own package: one-time when the owner priced
        // it once; otherwise the buyer picks monthly or yearly (yearly
        // only exists when the owner set a yearly amount — prices are
        // never invented here).
        const feePart = domainFeeLine(feeRaw, request.body.site_request.domain_interval === 'yearly');
        siteRequest.domain_interval = feePart ? feePart.interval : 'once';
        if (feePart) {
          lines.push(feePart.line);
          subtotal += BigInt(feePart.line.amount_minor);
        }
      }
      // The installation/configuration service package: optional,
      // separate, owner-priced in its own settings — added only when
      // the buyer explicitly opts in.
      let installation = false;
      if (request.body.installation) {
        const svc = (await getSetting(db, 'service.installation').catch(() => null)) as { enabled?: boolean; amount_minor?: number } | null;
        if (!svc?.enabled || typeof svc.amount_minor !== 'number' || svc.amount_minor <= 0) {
          throw errors.validation([{ field: 'installation', code: 'unavailable' }]);
        }
        const amt = BigInt(Math.trunc(svc.amount_minor));
        lines.push({ label: 'installation_service', interval: 'one_time', amount_minor: amt.toString() });
        subtotal += amt;
        installation = true;
      }
      const snapshot = {
        template_id: request.body.template_id,
        version_id: found.versionId,
        plan_id: found.plan.id,
        plan_code: found.plan.code,
        plan_name: found.plan.name,
        deployment_mode: found.plan.deployment_mode,
        lines,
        limits: found.plan.limits,
        ...(siteRequest ? { site_request: siteRequest } : {}),
        ...(billingInterval ? { billing_interval: billingInterval } : {}),
        ...(installation ? { installation: true } : {}),
        ...(upgradeEntitlementId ? { upgrade_entitlement_id: upgradeEntitlementId } : {}),
        storage_gb: storageGb,
        ...(storageRatePerGb !== null ? { storage_rate_per_gb: storageRatePerGb } : {}),
      };
      const { rows } = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at)
         VALUES ($1, $2, $3, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [auth.userId, config.currency, subtotal.toString(), snapshot, QUOTE_TTL_MINUTES],
      );
      return reply.status(201).send({
        data: {
          id: rows[0]!.id,
          currency: config.currency,
          subtotal_minor: subtotal.toString(),
          discount_minor: '0',
          tax_minor: '0',
          total_minor: subtotal.toString(),
          line_items: lines,
          deployment_mode: found.plan.deployment_mode,
          site_request: siteRequest,
          billing_interval: billingInterval ?? null,
          installation,
          upgrade_entitlement_id: upgradeEntitlementId,
          storage_gb: storageGb,
          expires_at: rows[0]!.expires_at.toISOString(),
        },
      });
    },
  );

  // The domain package on its own: a buyer whose site already exists
  // (created in the wizard, or bought without a name) buys/renews just
  // the name. The quote is a single fee line against that site; the
  // order carries no template item, and fulfilment extends the site's
  // domain_paid_until by the bought period.
  app.post<{ Body: { site_id: string; domain_interval?: 'monthly' | 'yearly' } }>(
    '/quotes/domain-package',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['site_id'], properties: { site_id: { type: 'string', pattern: UUID.source }, domain_interval: { enum: ['monthly', 'yearly'] } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const siteRes = await db.query<{ id: string; owner_id: string; subdomain: string; display_name: string }>(
        'SELECT id, owner_id, subdomain, display_name FROM sites WHERE id = $1',
        [request.body.site_id],
      );
      const site = siteRes.rows[0];
      if (!site || site.owner_id !== auth.userId) throw errors.notFound();
      const feeRaw = (await getSetting(db, 'subdomain.fee').catch(() => null)) as SubdomainFeeSetting | null;
      const feePart = domainFeeLine(feeRaw, request.body.domain_interval === 'yearly');
      if (!feePart) throw errors.conflict('domain.fee_unset');
      const lines: QuoteLine[] = [feePart.line];
      const subtotal = BigInt(feePart.line.amount_minor);
      const snapshot = {
        kind: 'domain_package',
        site_id: site.id,
        plan_name: { vi: 'Gói tên miền', en: 'Domain package' },
        deployment_mode: 'hosted',
        lines,
        limits: {},
        site_request: { subdomain: site.subdomain, display_name: site.display_name, locale: 'vi' as const, domain_interval: feePart.interval },
      };
      const { rows } = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at)
         VALUES ($1, $2, $3, $3, $4::jsonb, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [auth.userId, config.currency, subtotal.toString(), JSON.stringify(snapshot), QUOTE_TTL_MINUTES],
      );
      return reply.status(201).send({
        data: {
          id: rows[0]!.id,
          currency: config.currency,
          subtotal_minor: subtotal.toString(),
          total_minor: subtotal.toString(),
          line_items: lines,
          deployment_mode: 'hosted',
          site_request: snapshot.site_request,
          expires_at: rows[0]!.expires_at.toISOString(),
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>('/quotes/:id', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rows } = await db.query<{ buyer_id: string | null; currency: string; subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; snapshot_json: { lines: QuoteLine[]; deployment_mode: string; plan_name: Record<string, string>; site_request?: SiteRequest; billing_interval?: string; installation?: boolean; storage_gb?: number }; expires_at: Date }>(
      'SELECT buyer_id, currency, subtotal_minor::text, discount_minor::text, tax_minor::text, total_minor::text, snapshot_json, expires_at FROM quotes WHERE id = $1',
      [request.params.id],
    );
    const q = rows[0];
    if (!q || q.buyer_id !== auth.userId) throw errors.notFound();
    return {
      data: {
        id: request.params.id,
        currency: q.currency,
        subtotal_minor: q.subtotal_minor,
        discount_minor: q.discount_minor,
        tax_minor: q.tax_minor,
        total_minor: q.total_minor,
        line_items: q.snapshot_json.lines,
        deployment_mode: q.snapshot_json.deployment_mode,
        site_request: q.snapshot_json.site_request ?? null,
        billing_interval: q.snapshot_json.billing_interval ?? null,
        installation: q.snapshot_json.installation ?? false,
        storage_gb: q.snapshot_json.storage_gb ?? 1,
        plan_name: q.snapshot_json.plan_name,
        expires_at: q.expires_at.toISOString(),
        expired: q.expires_at <= new Date(),
      },
      meta: { request_id: request.id, revision: null },
    };
  });

  // POST /orders — create an order from a quote; requires a verified buyer (docs/04 §3).
  app.post<{ Body: { quote_id: string; terms_version: string } }>(
    '/orders',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['quote_id', 'terms_version'], properties: { quote_id: { type: 'string', pattern: UUID.source }, terms_version: { type: 'string', maxLength: 40 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (!auth.verified) throw errors.forbidden('buyer.unverified');
      const currentTerms = await getSetting<{ current: string }>(db, 'terms.version').then((v) => v.current);
      const result = await idempotent(
        db,
        { key: request.headers['idempotency-key'], principal: `user:${auth.userId}`, route: 'POST /orders', request: request.body },
        async (client) => {
          const quote = await client.query<{ id: string; buyer_id: string | null; currency: string; subtotal_minor: string; total_minor: string; snapshot_json: Record<string, unknown>; expired: boolean }>(
            'SELECT id, buyer_id, currency, subtotal_minor::text, total_minor::text, snapshot_json, expires_at <= now() AS expired FROM quotes WHERE id = $1 FOR UPDATE',
            [request.body.quote_id],
          );
          const q = quote.rows[0];
          if (!q || q.buyer_id !== auth.userId) throw errors.notFound();
          if (q.expired) throw errors.conflict('quote.expired');
          if (request.body.terms_version !== currentTerms) throw errors.conflict('terms.version_stale');
          // A quote is consumed by its first live order (audit payments
          // L3): while any non-cancelled order exists for it, no second
          // order may be created from it — a different Idempotency-Key
          // does not mint a second obligation from the same priced quote.
          // A cancelled order frees the quote (the buyer backed out
          // before paying), matching the partial unique index
          // orders_quote_single_live_uq (migration 0042), which is the
          // backstop for paths that do not take this quote lock.
          const consumed = await client.query<{ id: string }>(
            "SELECT id FROM orders WHERE quote_id = $1 AND status <> 'cancelled' LIMIT 1",
            [q.id],
          );
          if (consumed.rows[0]) throw errors.conflict('order.quote_consumed');
          const snap = q.snapshot_json as { template_id: string; version_id: string; plan_id: string; deployment_mode: string; plan_name: Record<string, string>; limits: Record<string, unknown>; site_request?: SiteRequest; billing_interval?: string; installation?: boolean; kind?: string; lines?: QuoteLine[]; storage_gb?: number; storage_rate_per_gb?: number };
          let orderId: string;
          try {
            const order = await client.query<{ id: string }>(
              `INSERT INTO orders (buyer_id, quote_id, currency, subtotal_minor, total_minor, locale, terms_version, payment_window_expires_at)
               VALUES ($1, $2, $3, $4, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
              [auth.userId, q.id, q.currency, q.total_minor, request.locale, request.body.terms_version, config.paymentWindowMinutes],
            );
            orderId = order.rows[0]!.id;
          } catch (error) {
            // Backstop race (another path created the live order first):
            // the partial unique index fires — surface the same API
            // error as the pre-check above, never a 500.
            if (isUniqueViolation(error, 'orders_quote_single_live_uq')) throw errors.conflict('order.quote_consumed');
            throw error;
          }
          // The standalone domain package has no template item: the
          // order is a single fee line against an existing site, and
          // fulfilment extends that site's domain paid period instead.
          if (snap.kind !== 'domain_package') {
            await client.query(
              `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [orderId, snap.template_id, snap.version_id, snap.plan_id, snap.deployment_mode, q.total_minor, { plan_name: snap.plan_name, updates_months: (snap.limits as { updates_months?: number }).updates_months ?? null, instance_limit: (snap.limits as { instance_limit?: number }).instance_limit ?? 1, ...(snap.site_request ? { site_request: snap.site_request } : {}), ...(snap.billing_interval ? { billing_interval: snap.billing_interval } : {}), ...(snap.installation ? { installation: true } : {}), ...(snap.lines?.some((l) => l.label === 'subdomain_fee') ? { domain_fee_paid: true } : {}), storage_gb: snap.storage_gb ?? 1, ...(snap.storage_rate_per_gb ? { storage_rate_per_gb: snap.storage_rate_per_gb } : {}) }],
            );
          }
          // The chosen name stays the buyer's while late settlement is
          // still plausible: stretch their hold to 24h from the order.
          // The order itself still auto-expires at its payment window;
          // an admin confirmation inside this horizon revives it and
          // fulfilment claims the name then.
          if (snap.site_request && snap.kind !== 'domain_package') {
            await client.query(
              "UPDATE subdomain_reservations SET expires_at = GREATEST(expires_at, now() + interval '24 hours') WHERE subdomain = $1 AND user_id = $2 AND status = 'active'",
              [snap.site_request.subdomain, auth.userId],
            );
          }
          await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'order.created', resourceType: 'order', resourceId: orderId, traceId: request.id });
          return { status: 201, body: { data: { id: orderId, status: 'awaiting_payment', total_minor: q.total_minor, currency: q.currency } } };
        },
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/orders', async (request) => {
    const auth = requireUser(request);
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const params: unknown[] = [auth.userId];
    let where = 'WHERE buyer_id = $1';
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const { rows } = await db.query<{ id: string; status: string; total_minor: string; currency: string; created_at: Date; paid_at: Date | null }>(
      `SELECT id, status, total_minor::text, currency, created_at, paid_at FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(rows, limit, (r) => ({ id: r.id, payment_status: r.status, total_minor: r.total_minor, currency: r.currency, created_at: r.created_at.toISOString(), paid_at: r.paid_at?.toISOString() ?? null }));
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; buyer_id: string; status: string; currency: string; subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; terms_version: string; paid_at: Date | null; created_at: Date; payment_window_expires_at: Date | null }>(
      'SELECT id, buyer_id, status, currency, subtotal_minor::text, discount_minor::text, tax_minor::text, total_minor::text, terms_version, paid_at, created_at, payment_window_expires_at FROM orders WHERE id = $1',
      [request.params.id],
    );
    const o = rows[0];
    if (!o || o.buyer_id !== auth.userId) throw errors.notFound();
    const items = await db.query('SELECT template_id, version_id, plan_id, deployment_mode, unit_price_minor::text, snapshot_json FROM order_items WHERE order_id = $1', [o.id]);
    const svcTask = await db.query<{ status: string }>("SELECT status FROM service_tasks WHERE order_id = $1 AND kind = 'installation' ORDER BY created_at LIMIT 1", [o.id]);
    return {
      data: {
        id: o.id,
        payment_status: o.status,
        currency: o.currency,
        subtotal_minor: o.subtotal_minor,
        discount_minor: o.discount_minor,
        tax_minor: o.tax_minor,
        total_minor: o.total_minor,
        terms_version: o.terms_version,
        items: items.rows,
        installation_status: svcTask.rows[0]?.status ?? null,
        paid_at: o.paid_at?.toISOString() ?? null,
        payment_window_expires_at: o.payment_window_expires_at?.toISOString() ?? null,
        created_at: o.created_at.toISOString(),
      },
      meta: { request_id: request.id, revision: null },
    };
  });

  // Create a payment session. The buyer may name a provider; the default is
  // bank transfer when the owner has enabled and configured it, otherwise
  // the sandbox mock. In production the mock can never be chosen at all —
  // nobody may check out for free by naming it, whatever their roles.
  app.post<{ Params: { id: string }; Body: { provider?: string } }>('/orders/:id/payment-sessions', async (request, reply) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; buyer_id: string; status: string; total_minor: string; currency: string }>(
      'SELECT id, buyer_id, status, total_minor::text, currency FROM orders WHERE id = $1',
      [request.params.id],
    );
    const o = rows[0];
    if (!o || o.buyer_id !== auth.userId) throw errors.notFound();
    if (o.status !== 'awaiting_payment') throw errors.conflict('order.not_payable');
    // Lazy expiry (the worker sweep does the same in bulk): past the
    // payment window the order is expired on the spot, with the clear
    // recorded state, and no new session may be opened on it.
    const stale = await tx(db, async (client) => expireStaleOrder(client, o.id, request.id));
    if (stale) throw errors.conflict('order.payment_expired');
    const bankSettings = await loadBankTransferSettings(db, config.partnerWebhookKey);
    const bankAvailable = bankTransferAvailable(bankSettings);
    const vnpaySettings = await loadVnPaySettings(db, config.partnerWebhookKey);
    const vnpayAvailable = vnPayAvailable(vnpaySettings);
    const momoSettings = await loadMoMoSettings(db, config.partnerWebhookKey);
    const momoAvailable = moMoAvailable(momoSettings);
    const paypalSettings = await loadPayPalSettings(db);
    const paypalAvailable = payPalAvailable(paypalSettings);
    const usdSettings = await loadUsdTransferSettings(db);
    const usdAvailable = usdTransferAvailable(usdSettings);
    const requested = typeof request.body?.provider === 'string' ? request.body.provider : null;
    const chosen = requested ?? (bankAvailable ? 'bank_transfer' : vnpayAvailable ? 'vnpay' : momoAvailable ? 'momo' : paypalAvailable ? 'paypal' : usdAvailable ? 'usd_transfer' : payment.name);
    const expiresAt = new Date(Date.now() + config.paymentWindowMinutes * 60_000);
    if (chosen === 'bank_transfer') {
      if (!bankAvailable) throw errors.conflict('payment.method_unavailable');
      const provider = new BankTransferProvider(bankSettings.hub_api_key, config.portalOrigin);
      // The content code is the attempt's unique reference; regenerate on the
      // (astronomically unlikely) collision instead of failing the checkout.
      for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
        const session = provider.createSession({ orderId: o.id, amountMinor: o.total_minor, currency: o.currency, returnUrl: `${config.portalOrigin}/checkout/orders/${o.id}/result`, expiresAt });
        // VietQR when the owner picked their bank (BIN set): the buyer's
        // banking app fills amount + content code from the scan.
        const qrPayload = /^[0-9]{6}$/.test(bankSettings.bank_bin)
          ? buildVietQrPayload({ bankBin: bankSettings.bank_bin, accountNumber: bankSettings.account_number, amountMinor: o.total_minor, content: session.providerRef })
          : null;
        const instructions = {
          bank_name: bankSettings.bank_name,
          account_number: bankSettings.account_number,
          account_holder: bankSettings.account_holder,
          content_code: session.providerRef,
          amount_minor: o.total_minor,
          currency: o.currency,
          ...(qrPayload ? { qr_payload: qrPayload } : {}),
        };
        try {
          await db.query(
            "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json) VALUES ($1, 'bank_transfer', $2, $3, $4, 'pending', $5::jsonb)",
            [o.id, session.providerRef, o.total_minor, o.currency, JSON.stringify(instructions)],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505' && attemptNo < 2) continue;
          throw err;
        }
        return reply.status(201).send({ data: { provider: 'bank_transfer', sandbox: false, provider_ref: session.providerRef, pay_url: session.payUrl, expires_at: session.expiresAt.toISOString(), instructions } });
      }
      throw errors.conflict('payment.method_unavailable');
    }
    if (chosen === 'vnpay') {
      if (!vnpayAvailable) throw errors.conflict('payment.method_unavailable');
      const provider = new VnPayProvider({ tmnCode: vnpaySettings.tmn_code, secret: vnpaySettings.secret_key, sandbox: vnpaySettings.sandbox });
      const session = provider.createSession({ orderId: o.id, amountMinor: o.total_minor, currency: o.currency, returnUrl: `${config.portalOrigin}/checkout/orders/${o.id}/result`, expiresAt, ipAddr: request.ip });
      await db.query(
        "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status) VALUES ($1, 'vnpay', $2, $3, $4, 'pending')",
        [o.id, session.providerRef, o.total_minor, o.currency],
      );
      return reply.status(201).send({ data: { provider: 'vnpay', sandbox: vnpaySettings.sandbox, provider_ref: session.providerRef, pay_url: session.payUrl, expires_at: session.expiresAt.toISOString() } });
    }
    if (chosen === 'momo') {
      if (!momoAvailable) throw errors.conflict('payment.method_unavailable');
      const provider = new MoMoProvider({ partnerCode: momoSettings.partner_code, accessKey: momoSettings.access_key, secretKey: momoSettings.secret_key, sandbox: momoSettings.sandbox });
      const orderRef = MoMoProvider.newOrderRef();
      const body = provider.buildCreateBody({
        orderRef,
        amountMinor: o.total_minor,
        redirectUrl: `${config.portalOrigin}/checkout/orders/${o.id}/result`,
        ipnUrl: `${config.portalOrigin}/api/v1/payments/webhooks/momo`,
      });
      let payUrl: string | null = null;
      let qrPayload: string | null = null;
      try {
        const res = await fetch(provider.createEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const parsed = parseMoMoCreateResponse((await res.json()) as Record<string, unknown>);
        if (parsed) {
          payUrl = parsed.payUrl;
          qrPayload = parsed.qrPayload;
        }
      } catch {
        payUrl = null;
      }
      if (!payUrl) throw errors.conflict('payment.method_unavailable', true);
      // MoMo answers with its own scannable QR payload: persist it on the
      // attempt so the pay page renders the QR automatically.
      if (qrPayload) {
        await db.query(
          "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json) VALUES ($1, 'momo', $2, $3, $4, 'pending', $5::jsonb)",
          [o.id, orderRef, o.total_minor, o.currency, JSON.stringify({ qr_payload: qrPayload })],
        );
      } else {
        await db.query(
          "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status) VALUES ($1, 'momo', $2, $3, $4, 'pending')",
          [o.id, orderRef, o.total_minor, o.currency],
        );
      }
      return reply.status(201).send({ data: { provider: 'momo', sandbox: momoSettings.sandbox, provider_ref: orderRef, pay_url: payUrl, expires_at: expiresAt.toISOString(), ...(qrPayload ? { instructions: { qr_payload: qrPayload } } : {}) } });
    }
    if (chosen === 'paypal') {
      if (!paypalAvailable) throw errors.conflict('payment.method_unavailable');
      // Manual method: freeze the receiving account + the per-order
      // reference (which doubles as the attempt's provider_ref) into the
      // instructions; staff settle it from reconciliation.
      for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
        const ref = manualTransferRef('PP');
        const instructions = {
          paypal_email: paypalSettings.email,
          account_holder: paypalSettings.holder,
          content_code: ref,
          amount_minor: o.total_minor,
          currency: o.currency,
        };
        try {
          await db.query(
            "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json) VALUES ($1, 'paypal', $2, $3, $4, 'pending', $5::jsonb)",
            [o.id, ref, o.total_minor, o.currency, JSON.stringify(instructions)],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505' && attemptNo < 2) continue;
          throw err;
        }
        return reply.status(201).send({ data: { provider: 'paypal', sandbox: false, provider_ref: ref, pay_url: `${config.portalOrigin}/checkout/orders/${o.id}/pay`, expires_at: expiresAt.toISOString(), instructions } });
      }
      throw errors.conflict('payment.method_unavailable');
    }
    if (chosen === 'usd_transfer') {
      if (!usdAvailable) throw errors.conflict('payment.method_unavailable');
      for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
        const ref = manualTransferRef('US');
        const instructions = {
          bank_name: usdSettings.bank_name,
          account_number: usdSettings.account_number,
          account_holder: usdSettings.account_holder,
          swift_code: usdSettings.swift_code,
          content_code: ref,
          amount_minor: o.total_minor,
          currency: o.currency,
          usd_rate: usdSettings.usd_rate,
          amount_usd: usdAmountFor(o.total_minor, usdSettings.usd_rate),
        };
        try {
          await db.query(
            "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json) VALUES ($1, 'usd_transfer', $2, $3, $4, 'pending', $5::jsonb)",
            [o.id, ref, o.total_minor, o.currency, JSON.stringify(instructions)],
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505' && attemptNo < 2) continue;
          throw err;
        }
        return reply.status(201).send({ data: { provider: 'usd_transfer', sandbox: false, provider_ref: ref, pay_url: `${config.portalOrigin}/checkout/orders/${o.id}/pay`, expires_at: expiresAt.toISOString(), instructions } });
      }
      throw errors.conflict('payment.method_unavailable');
    }
    if (chosen !== payment.name) throw errors.conflict('payment.method_unavailable');
    // Production: the mock provider is ENTIRELY unavailable (audit
    // payments L1, wave 3). No account — whatever roles it holds — may
    // create a mock session, so nobody can free-"test-buy" an entitlement
    // while no real method is configured; the honest answer is "not
    // payable yet". Staff test purchases happen in non-production only.
    if (config.env === 'production') throw errors.conflict('payment.method_unavailable');
    const session = payment.createSession({ orderId: o.id, amountMinor: o.total_minor, currency: o.currency, returnUrl: `${config.portalOrigin}/checkout/orders/${o.id}/result`, expiresAt });
    await db.query(
      "INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
      [o.id, payment.name, session.providerRef, o.total_minor, o.currency],
    );
    return reply.status(201).send({ data: { provider: payment.name, sandbox: payment.sandbox, provider_ref: session.providerRef, pay_url: session.payUrl, expires_at: session.expiresAt.toISOString() } });
  });

  app.post<{ Params: { id: string } }>('/orders/:id/cancel', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rowCount } = await db.query(
      "UPDATE orders SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1 AND buyer_id = $2 AND status = 'awaiting_payment'",
      [request.params.id, auth.userId],
    );
    if (rowCount !== 1) throw errors.conflict('order.not_cancellable');
    return { data: { status: 'cancelled' } };
  });

  // Buyer view of an order's payment attempts (B05 issue screen; no bank internals exposed).
  app.get<{ Params: { id: string } }>('/orders/:id/payment-attempts', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const order = await db.query('SELECT id FROM orders WHERE id = $1 AND buyer_id = $2', [request.params.id, auth.userId]);
    if (!order.rows[0]) throw errors.notFound();
    const { rows } = await db.query<{ id: string; provider: string; provider_ref: string | null; amount_minor: string; currency: string; status: string; created_at: Date; instructions_json: unknown }>(
      'SELECT id, provider, provider_ref, amount_minor::text, currency, status, created_at, instructions_json FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC',
      [request.params.id],
    );
    return { data: rows.map((r) => ({ id: r.id, provider: r.provider, provider_ref: r.provider_ref, amount_minor: r.amount_minor, currency: r.currency, status: r.status, created_at: r.created_at.toISOString(), instructions: r.provider === 'bank_transfer' || r.provider === 'paypal' || r.provider === 'usd_transfer' || r.provider === 'momo' ? r.instructions_json : undefined })), page: { next_cursor: null, has_more: false } };
  });

  // Buyer requests a refund (B05). Amount must not exceed the not-yet-refunded remainder;
  // staff approve/reject it (payment:refund) and the provider settles it (AT-56).
  app.post<{ Params: { id: string }; Body: { amount_minor: string; reason?: string } }>(
    '/orders/:id/refund-requests',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['amount_minor'], properties: { amount_minor: { type: 'string', pattern: '^[0-9]+$' }, reason: { type: 'string', maxLength: 500 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      assertId(request.params.id);
      const result = await tx(db, async (client) => {
        const order = await client.query<{ status: string; total_minor: string; currency: string }>(
          'SELECT status, total_minor::text, currency FROM orders WHERE id = $1 AND buyer_id = $2 FOR UPDATE',
          [request.params.id, auth.userId],
        );
        const o = order.rows[0];
        if (!o) throw errors.notFound();
        if (o.status !== 'paid' && o.status !== 'partially_refunded' && o.status !== 'refund_pending') throw errors.conflict('refund.order_not_refundable');
        const sums = await client.query<{ used: string }>(
          `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('requested', 'pending', 'confirmed')), 0)::text AS used FROM refunds WHERE order_id = $1`,
          [request.params.id],
        );
        const remaining = BigInt(o.total_minor) - BigInt(sums.rows[0]!.used);
        const amount = BigInt(request.body.amount_minor);
        if (amount <= 0n || amount > remaining) throw errors.conflict('refund.amount_exceeds_remaining');
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO refunds (order_id, buyer_id, amount_minor, currency, reason, requested_by)
           VALUES ($1, $2, $3, $4, $5, $2) RETURNING id`,
          [request.params.id, auth.userId, amount.toString(), o.currency, request.body.reason ?? ''],
        );
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'refund.requested', resourceType: 'refund', resourceId: rows[0]!.id, traceId: request.id });
        return rows[0]!.id;
      });
      return reply.status(201).send({ data: { id: result, status: 'requested' } });
    },
  );

  app.get<{ Params: { id: string } }>('/orders/:id/refund-requests', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const order = await db.query('SELECT id FROM orders WHERE id = $1 AND buyer_id = $2', [request.params.id, auth.userId]);
    if (!order.rows[0]) throw errors.notFound();
    const { rows } = await db.query<{ id: string; amount_minor: string; currency: string; status: string; reason: string; created_at: Date }>(
      'SELECT id, amount_minor::text, currency, status, reason, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at DESC',
      [request.params.id],
    );
    return { data: rows.map((r) => ({ id: r.id, amount_minor: r.amount_minor, currency: r.currency, status: r.status, reason: r.reason, created_at: r.created_at.toISOString() })), page: { next_cursor: null, has_more: false } };
  });

  // Sandbox: simulate the provider settling the payment. Clearly a mock; never real money.
  app.post<{ Params: { ref: string } }>(
    '/payments/mock/:ref/confirm',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!payment.sandbox) throw errors.notFound();
      // Production: the mock provider is entirely unavailable (audit
      // payments L1, wave 3) — no role may settle a mock payment/refund.
      if (config.env === 'production') throw errors.notFound();
      const { rows } = await db.query<{ amount_minor: string; currency: string; status: string }>(
        'SELECT amount_minor::text, currency, status FROM payment_attempts WHERE provider = $1 AND provider_ref = $2',
        [payment.name, request.params.ref],
      );
      const attempt = rows[0];
      if (!attempt) throw errors.notFound();
      const signed = payment.signEvent({ providerRef: request.params.ref, status: 'settled', amountMinor: attempt.amount_minor, currency: attempt.currency });
      const event = payment.verifyWebhook(signed.body, signed.headers);
      const outcome = await processPaymentEvent(db, payment.name, signed.body, event);
      return reply.status(202).send({ data: { status: 'processing', outcome, sandbox: true } });
    },
  );

  // Sandbox: simulate the provider settling / failing an approved refund (AT-56).
  // A failed refund can later be confirmed; the confirmed event applies exactly once.
  app.post<{ Params: { ref: string } }>(
    '/payments/mock/refunds/:ref/confirm',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!payment.sandbox) throw errors.notFound();
      // Production: the mock provider is entirely unavailable (audit
      // payments L1, wave 3) — no role may settle a mock payment/refund.
      if (config.env === 'production') throw errors.notFound();
      const { rows } = await db.query<{ amount_minor: string; currency: string; status: string }>(
        'SELECT amount_minor::text, currency, status FROM refunds WHERE provider = $1 AND provider_ref = $2',
        [payment.name, request.params.ref],
      );
      const refund = rows[0];
      if (!refund) throw errors.notFound();
      if (refund.status !== 'pending') throw errors.conflict('refund.not_pending');
      const signed = payment.signRefundEvent({ refundRef: request.params.ref, status: 'confirmed', amountMinor: refund.amount_minor, currency: refund.currency });
      const event = payment.verifyRefundWebhook(signed.body, signed.headers);
      const outcome = await processRefundEvent(db, payment.name, signed.body, event);
      return reply.status(202).send({ data: { status: 'processing', outcome, sandbox: true } });
    },
  );

  app.post<{ Params: { ref: string } }>(
    '/payments/mock/refunds/:ref/fail',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!payment.sandbox) throw errors.notFound();
      // Production: the mock provider is entirely unavailable (audit
      // payments L1, wave 3) — no role may settle a mock payment/refund.
      if (config.env === 'production') throw errors.notFound();
      const { rows } = await db.query<{ amount_minor: string; currency: string; status: string }>(
        'SELECT amount_minor::text, currency, status FROM refunds WHERE provider = $1 AND provider_ref = $2',
        [payment.name, request.params.ref],
      );
      const refund = rows[0];
      if (!refund) throw errors.notFound();
      if (refund.status !== 'pending') throw errors.conflict('refund.not_pending');
      const signed = payment.signRefundEvent({ refundRef: request.params.ref, status: 'failed', amountMinor: refund.amount_minor, currency: refund.currency });
      const event = payment.verifyRefundWebhook(signed.body, signed.headers);
      const outcome = await processRefundEvent(db, payment.name, signed.body, event);
      return reply.status(202).send({ data: { status: 'processing', outcome, sandbox: true } });
    },
  );

  // Real provider refund webhook: verify, dedupe, process (server-to-server, signature-authenticated).
  // The signature is verified over the exact raw bytes captured by the
  // preParsing hook (audit code L-01), never a re-serialised body.
  app.post('/payments/refund-webhooks/:provider', { preParsing: captureRawBody }, async (request, reply) => {
    const providerName = (request.params as { provider: string }).provider;
    if (providerName !== payment.name) throw errors.notFound();
    // Production: the mock provider is entirely unavailable (audit payments L1).
    if (config.env === 'production') throw errors.notFound();
    const raw = rawBodyOf(request);
    let event: ReturnType<typeof payment.verifyRefundWebhook>;
    try {
      event = payment.verifyRefundWebhook(raw, request.headers as Record<string, string | undefined>);
    } catch {
      throw errors.badRequest('payment.webhook_invalid');
    }
    const outcome = await processRefundEvent(db, providerName, raw, event);
    return reply.status(200).send({ received: true, outcome });
  });

  // Real webhook endpoint: verify, dedupe, process. Returns 2xx after a durable record.
  // Signatures are verified over the exact raw bytes captured by the
  // preParsing hook below (audit code L-01) for every provider on this
  // route — mock, bank hub, Casso, VNPay and MoMo alike.

  // VNPay IPN (GET or POST): always HTTP 200 with VNPay's own RspCode body.
  async function handleVnPayIpn(params: Record<string, string>, reply: FastifyReply) {
    const settings = await loadVnPaySettings(db, config.partnerWebhookKey);
    if (!vnPayAvailable(settings)) {
      return reply.status(200).send({ RspCode: '01', Message: 'Order not found' });
    }
    const provider = new VnPayProvider({ tmnCode: settings.tmn_code, secret: settings.secret_key, sandbox: settings.sandbox });
    let event: NormalizedEvent;
    try {
      event = provider.verifyWebhook(new URLSearchParams(params).toString());
    } catch {
      return reply.status(200).send({ RspCode: '97', Message: 'Invalid signature' });
    }
    const outcome = await processPaymentEvent(db, 'vnpay', JSON.stringify(params), event);
    if (outcome === 'processed') return reply.status(200).send({ RspCode: '00', Message: 'Confirm Success' });
    if (outcome === 'duplicate') return reply.status(200).send({ RspCode: '02', Message: 'Order already confirmed' });
    if (outcome === 'needs_reconciliation') return reply.status(200).send({ RspCode: '04', Message: 'Invalid amount' });
    return reply.status(200).send({ RspCode: '01', Message: 'Order not found' });
  }

  app.get('/payments/webhooks/vnpay', async (request, reply) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.query as Record<string, unknown>)) params[k] = String(v);
    return handleVnPayIpn(params, reply);
  });

  app.post('/payments/webhooks/:provider', { preParsing: captureRawBody }, async (request: FastifyRequest, reply) => {
    const providerName = (request.params as { provider: string }).provider;
    const raw = rawBodyOf(request);
    // Bank transfer hub (SePay-compatible): the provider is configured from
    // admin settings at request time, so rotating the hub key needs no deploy.
    if (providerName === 'bank_transfer') {
      const settings = await loadBankTransferSettings(db, config.partnerWebhookKey);
      const provider = new BankTransferProvider(settings.hub_api_key, config.portalOrigin);
      let event: NormalizedEvent;
      try {
        event = provider.verifyWebhook(raw, request.headers as Record<string, string | undefined>);
      } catch {
        throw errors.badRequest('payment.webhook_invalid');
      }
      const outcome = await processPaymentEvent(db, 'bank_transfer', raw, event);
      return reply.status(200).send({ received: true, outcome });
    }
    // Casso hub: same bank settings (the owner sets the hub key as Casso's
    // Security Key), batch payload { error: 0, data: [tx, ...] } authenticated
    // by the secure-token header. Events settle through the bank_transfer
    // pipeline; the reply carries success:true for Casso's strict mode.
    if (providerName === 'casso') {
      const settings = await loadBankTransferSettings(db, config.partnerWebhookKey);
      const provider = new CassoHubProvider(settings.hub_api_key);
      let events: NormalizedEvent[];
      try {
        events = provider.verifyWebhookBatch(raw, request.headers as Record<string, string | undefined>);
      } catch {
        return reply.status(401).send({ success: false, error: 'invalid secure-token' });
      }
      const outcomes: string[] = [];
      for (const event of events) {
        outcomes.push(await processPaymentEvent(db, 'bank_transfer', raw, event));
      }
      return reply.status(200).send({ success: true, received: true, outcomes });
    }
    if (providerName === 'vnpay') {
      const params: Record<string, string> = {};
      const src = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(src)) params[k] = String(v);
      return handleVnPayIpn(params, reply);
    }
    // MoMo IPN: signature-verified, then MoMo expects a bare 204 back.
    if (providerName === 'momo') {
      const settings = await loadMoMoSettings(db, config.partnerWebhookKey);
      if (!moMoAvailable(settings)) throw errors.notFound();
      const provider = new MoMoProvider({ partnerCode: settings.partner_code, accessKey: settings.access_key, secretKey: settings.secret_key, sandbox: settings.sandbox });
      let event: NormalizedEvent;
      try {
        event = provider.verifyIpn(raw);
      } catch {
        throw errors.badRequest('payment.webhook_invalid');
      }
      await processPaymentEvent(db, 'momo', raw, event);
      return reply.status(204).send();
    }
    if (providerName !== payment.name) throw errors.notFound();
    // Production: the mock provider is entirely unavailable (audit payments L1).
    if (config.env === 'production') throw errors.notFound();
    let event: NormalizedEvent;
    try {
      event = payment.verifyWebhook(raw, request.headers as Record<string, string | undefined>);
    } catch {
      throw errors.badRequest('payment.webhook_invalid');
    }
    const outcome = await processPaymentEvent(db, providerName, raw, event);
    return reply.status(200).send({ received: true, outcome });
  });

  // Entitlements and downloads -----------------------------------------------------------------

  app.get('/me/entitlements', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ id: string; mode: string; status: string; instance_limit: number; storage_gb: number; updates_until: Date | null; template_id: string; version_id: string; slug: string; semver: string; adapter: string; created_at: Date; requested_subdomain: string | null; requested_display_name: string | null }>(
      `SELECT e.id, e.mode, e.status, e.instance_limit, e.storage_gb, e.updates_until, e.template_id, e.version_id, t.slug, v.semver, v.adapter, e.created_at,
              oi.snapshot_json -> 'site_request' ->> 'subdomain' AS requested_subdomain,
              oi.snapshot_json -> 'site_request' ->> 'display_name' AS requested_display_name
       FROM entitlements e JOIN templates t ON t.id = e.template_id JOIN template_versions v ON v.id = e.version_id
       LEFT JOIN order_items oi ON oi.id = e.order_item_id
       WHERE e.user_id = $1 ORDER BY e.created_at DESC`,
      [auth.userId],
    );
    // Sites already created from these entitlements: the purchases page and
    // the create-site wizard must not present a fully-used entitlement as if
    // no website existed yet (the hosted checkout auto-creates the first
    // site, so "pending creation" wording is stale for most hosted buyers).
    const entIds = rows.map((e) => e.id);
    const siteRows = entIds.length
      ? (await db.query<{ id: string; entitlement_id: string; display_name: string; status: string; subdomain: string | null }>(
          `SELECT id, entitlement_id, display_name, status, subdomain FROM sites
           WHERE entitlement_id = ANY($1) AND status <> 'purged' ORDER BY created_at DESC`,
          [entIds],
        )).rows
      : [];
    const sitesByEnt = new Map<string, typeof siteRows>();
    for (const s of siteRows) {
      const arr = sitesByEnt.get(s.entitlement_id) ?? [];
      arr.push(s);
      sitesByEnt.set(s.entitlement_id, arr);
    }
    return {
      data: rows.map((e) => {
        const entSites = sitesByEnt.get(e.id) ?? [];
        const usedInstances = entSites.length;
        const firstSite = entSites[0];
        return {
        id: e.id,
        mode: e.mode,
        status: e.status,
        instance_limit: e.instance_limit,
        used_instances: usedInstances,
        free_instances: Math.max(0, e.instance_limit - usedInstances),
        site: firstSite ? { id: firstSite.id, display_name: firstSite.display_name, status: firstSite.status, subdomain: firstSite.subdomain } : null,
        storage_gb: e.storage_gb ?? 1,
        updates_until: e.updates_until?.toISOString() ?? null,
        requested_subdomain: e.requested_subdomain,
        requested_display_name: e.requested_display_name,
        template: { id: e.template_id, slug: e.slug, adapter: e.adapter },
        version: { id: e.version_id, semver: e.semver },
        created_at: e.created_at.toISOString(),
        };
      }),
      page: { next_cursor: null, has_more: false },
    };
  });

  // Issue a short-lived download grant for a self-host entitlement; the bundle is built on demand.
  // variant 'demo' (default) ships the template as-is; 'clean' strips the
  // 3T demo phone to a fill-in placeholder (see toCleanVariantText).
  app.post<{ Params: { id: string }; Body: { variant?: unknown } }>('/entitlements/:id/download-links', async (request, reply) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const body = (request.body ?? {}) as { variant?: unknown };
    const variant = body.variant ?? 'demo';
    if (variant !== 'demo' && variant !== 'clean') throw errors.validation([{ field: 'variant', code: 'invalid' }], 'download.variant_invalid');
    const ent = await db.query<{ id: string; mode: string; status: string; version_id: string; updates_until: Date | null }>(
      'SELECT id, mode, status, version_id, updates_until FROM entitlements WHERE id = $1 AND user_id = $2',
      [request.params.id, auth.userId],
    );
    const e = ent.rows[0];
    if (!e) throw errors.notFound();
    if (e.mode !== 'selfhost') throw errors.conflict('entitlement.not_downloadable');
    if (e.status !== 'active') throw errors.forbidden('entitlement.inactive');

    const version = await db.query<{ slug: string; semver: string; manifest_json: Record<string, unknown>; title: string; site_key: string; site_sha: string }>(
      `SELECT t.slug, v.semver, v.manifest_json,
              COALESCE((SELECT tt.title FROM template_translations tt WHERE tt.template_id = t.id AND tt.locale = 'vi'), t.slug) AS title,
              a.object_key AS site_key, a.sha256 AS site_sha
       FROM template_versions v JOIN templates t ON t.id = v.template_id JOIN artifacts a ON a.id = v.artifact_id
       WHERE v.id = $1`,
      [e.version_id],
    );
    const v = version.rows[0];
    if (!v) throw errors.notFound();

    // v2 bundles carry the runtime layout (app/ + compose) for runtime adapters;
    // v1 bundles were static-only and are never served again.
    // Clean bundles are a separate cached key so demo and clean never mix.
    const bundleKey = `bundles/selfhost/v2/${e.version_id}${variant === 'clean' ? '-clean' : ''}.zip`;
    let bundle: { size: number; sha256: string };
    if (await store.exists(bundleKey)) {
      const info = await db.query<{ size_bytes: string; sha256: string }>("SELECT size_bytes::text, sha256 FROM artifacts WHERE object_key = $1", [bundleKey]);
      bundle = info.rows[0] ? { size: Number(info.rows[0].size_bytes), sha256: info.rows[0].sha256 } : await rebuildBundle();
    } else {
      bundle = await rebuildBundle();
    }

    async function rebuildBundle() {
      const siteDir = store.pathFor(v!.site_key);
      let treeDir = siteDir;
      let cleanDir: string | null = null;
      if (variant === 'clean') {
        cleanDir = join(config.workDir, 'bundles-clean', `${e!.version_id}`);
        await rm(cleanDir, { recursive: true, force: true });
        await buildCleanSiteTree(siteDir, cleanDir);
        treeDir = cleanDir;
      }
      const tmpDir = join(config.workDir, 'bundles');
      await mkdir(tmpDir, { recursive: true });
      const tmp = join(tmpDir, `${e!.version_id}${variant === 'clean' ? '-clean' : ''}.zip`);
      await rm(tmp, { force: true });
      const built = await buildSelfhostBundle(treeDir, tmp, { slug: v!.slug, version: v!.semver, title: v!.title, manifest: v!.manifest_json });
      if (!(await store.exists(bundleKey))) {
        await store.putStream(bundleKey, createReadStream(tmp), built.size + 1);
        await db.query(
          `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
           VALUES ($1, $2, $3, 'application/zip', 'source_archive', 'permanent', $4) ON CONFLICT (object_key) DO NOTHING`,
          [bundleKey, built.sha256, String(built.size), { kind: 'selfhost_bundle', variant, version_id: e!.version_id }],
        );
      }
      await rm(tmp, { force: true });
      if (cleanDir) await rm(cleanDir, { recursive: true, force: true });
      return built;
    }

    const artifactRow = await db.query<{ id: string }>('SELECT id FROM artifacts WHERE object_key = $1', [bundleKey]);
    const token = randomToken();
    await db.query(
      `INSERT INTO download_events (entitlement_id, artifact_id, version_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
      [e.id, artifactRow.rows[0]!.id, e.version_id, auth.userId, hashToken(token)],
    );
    await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'download.issued', resourceType: 'entitlement', resourceId: e.id, traceId: request.id, diff: { variant } });
    return reply.status(201).send({
      data: {
        url: `${config.portalOrigin}/api/v1/downloads/${token}`,
        filename: `${v.slug}-${v.semver}${variant === 'clean' ? '-clean' : ''}.zip`,
        sha256: bundle.sha256,
        size_bytes: String(bundle.size),
        variant,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
  });

  // Redeem a one-time download token and stream the bundle. Re-checks authorization each time.
  app.get<{ Params: { token: string } }>('/downloads/:token', async (request, reply) => {
    const auth = requireUser(request);
    const token = request.params.token;
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) throw errors.notFound();
    const grant = await tx(db, async (client: PoolClient) => {
      const { rows } = await client.query<{ id: string; artifact_id: string; user_id: string; expired: boolean; used_at: Date | null; ent_status: string }>(
        `SELECT d.id, d.artifact_id, d.user_id, d.expires_at <= now() AS expired, d.used_at, e.status AS ent_status
         FROM download_events d JOIN entitlements e ON e.id = d.entitlement_id
         WHERE d.token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const g = rows[0];
      if (!g || g.user_id !== auth.userId) throw errors.notFound();
      if (g.expired || g.used_at) throw errors.conflict('download.link_expired', true);
      if (g.ent_status !== 'active') throw errors.forbidden('entitlement.inactive');
      await client.query('UPDATE download_events SET used_at = now() WHERE id = $1', [g.id]);
      const artifact = await client.query<{ object_key: string; size_bytes: string; slug: string; semver: string; metadata_json: { variant?: string } | null }>(
        `SELECT a.object_key, a.size_bytes::text, t.slug, v.semver, a.metadata_json
         FROM artifacts a JOIN download_events d ON d.artifact_id = a.id
         JOIN template_versions v ON v.id = d.version_id JOIN templates t ON t.id = v.template_id
         WHERE a.id = $1 AND d.id = $2`,
        [g.artifact_id, g.id],
      );
      return artifact.rows[0]!;
    });
    reply.header('content-type', 'application/zip');
    reply.header('content-length', grant.size_bytes);
    reply.header('content-disposition', `attachment; filename="${grant.slug}-${grant.semver}${grant.metadata_json?.variant === 'clean' ? '-clean' : ''}.zip"`);
    return reply.send(store.read(grant.object_key));
  });

  // Buyer download history for one entitlement (C03): history only, never a live link.
  app.get<{ Params: { id: string } }>('/entitlements/:id/downloads', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const ent = await db.query<{ id: string; mode: string; status: string; updates_until: Date | null; slug: string; semver: string }>(
      `SELECT e.id, e.mode, e.status, e.updates_until, t.slug, v.semver
       FROM entitlements e JOIN templates t ON t.id = e.template_id JOIN template_versions v ON v.id = e.version_id
       WHERE e.id = $1 AND e.user_id = $2`,
      [request.params.id, auth.userId],
    );
    const e = ent.rows[0];
    if (!e) throw errors.notFound();
    const { rows } = await db.query<{ id: string; issued_at: Date; used_at: Date | null; expires_at: Date }>(
      'SELECT id, issued_at, used_at, expires_at FROM download_events WHERE entitlement_id = $1 ORDER BY issued_at DESC LIMIT 100',
      [request.params.id],
    );
    return {
      data: {
        entitlement: { id: e.id, mode: e.mode, status: e.status, updates_until: e.updates_until?.toISOString() ?? null, template_slug: e.slug, version: e.semver },
        downloads: rows.map((r) => ({ id: r.id, issued_at: r.issued_at.toISOString(), used: r.used_at !== null, expired: r.expires_at <= new Date() })),
      },
    };
  });

  app.get('/me/downloads', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ id: string; version_id: string; slug: string; semver: string; issued_at: Date; used_at: Date | null; expires_at: Date }>(
      `SELECT d.id, d.version_id, t.slug, v.semver, d.issued_at, d.used_at, d.expires_at
       FROM download_events d JOIN template_versions v ON v.id = d.version_id JOIN templates t ON t.id = v.template_id
       WHERE d.user_id = $1 ORDER BY d.issued_at DESC LIMIT 100`,
      [auth.userId],
    );
    // Never return a still-valid link; history only (docs/04 §3).
    return {
      data: rows.map((r) => ({ id: r.id, template_slug: r.slug, version: r.semver, issued_at: r.issued_at.toISOString(), used: r.used_at !== null, expired: r.expires_at <= new Date() })),
      page: { next_cursor: null, has_more: false },
    };
  });
}
