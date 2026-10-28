import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from '@3t/core';
import {
  buildCleanSiteTree,
  buildSelfhostBundle,
  emitEvent,
  getSetting,
  hashToken,
  loadActivePlans,
  randomToken,
  tx,
  writeAudit,
  type Db,
  type NormalizedEvent,
  type PublicPlan,
} from '@3t/core';
import { requireUser } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { accrueOrderCommission, reverseOrderCommission } from '../lib/partner-ledger.ts';
import { emitPartnerEvent } from '../lib/partner-webhooks.ts';
import { idempotent } from '../lib/idempotency.ts';
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

/**
 * Compute what a buyer first pays for a plan from its current prices (never from the client):
 * self-host is a single one-time fee; hosting is an optional setup fee plus the first period.
 */
export function computeCharge(plan: PublicPlan): { subtotal: bigint; lines: QuoteLine[] } {
  const oneTime = plan.prices.find((p) => p.interval === 'one_time');
  const recurring = plan.prices.find((p) => p.interval === 'monthly' || p.interval === 'yearly');
  const lines: QuoteLine[] = [];
  let subtotal = 0n;
  if (plan.deployment_mode === 'selfhost') {
    if (!oneTime) throw errors.conflict('plan.not_purchasable');
    lines.push({ label: plan.code, interval: 'one_time', amount_minor: oneTime.amount_minor });
    subtotal = BigInt(oneTime.amount_minor);
  } else {
    if (!recurring) throw errors.conflict('plan.not_purchasable');
    if (oneTime) {
      lines.push({ label: `${plan.code}:setup`, interval: 'one_time', amount_minor: oneTime.amount_minor });
      subtotal += BigInt(oneTime.amount_minor);
    }
    lines.push({ label: `${plan.code}:first_period`, interval: recurring.interval, amount_minor: recurring.amount_minor });
    subtotal += BigInt(recurring.amount_minor);
  }
  return { subtotal, lines };
}

/**
 * Fulfil a paid order: one entitlement per order item (unique per item, invariant §6.3),
 * order marked paid, outbox event + audit. Callers must already hold the order row lock
 * and have decided the order may move to paid.
 */
export async function fulfillOrder(client: PoolClient, orderId: string, buyerId: string, traceId: string): Promise<void> {
  const items = await client.query<{ id: string; template_id: string; version_id: string; deployment_mode: string; snapshot_json: { updates_months?: number; instance_limit?: number } }>(
    'SELECT id, template_id, version_id, deployment_mode, snapshot_json FROM order_items WHERE order_id = $1',
    [orderId],
  );
  for (const item of items.rows) {
    const updatesMonths = item.snapshot_json.updates_months ?? null;
    const instanceLimit = item.snapshot_json.instance_limit ?? 1;
    await client.query(
      `INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit, updates_until, runtime_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6,
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(months => $7::int) END,
               NULL)
       ON CONFLICT (order_item_id) DO NOTHING`,
      [item.id, buyerId, item.template_id, item.version_id, item.deployment_mode, instanceLimit, updatesMonths],
    );
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
async function processPaymentEvent(db: Db, provider: string, rawBody: string, event: NormalizedEvent): Promise<'processed' | 'duplicate' | 'ignored' | 'needs_reconciliation'> {
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
      await client.query("UPDATE payment_events SET processing_status = 'ignored' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'ignored';
    }
    await client.query('UPDATE payment_events SET order_id = $3 WHERE provider = $1 AND provider_event_id = $2', [provider, event.providerEventId, pa.order_id]);

    if (event.status !== 'settled') {
      await client.query("UPDATE payment_attempts SET status = 'failed' WHERE id = $1", [pa.id]);
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
      await client.query("UPDATE orders SET status = 'needs_reconciliation', row_version = row_version + 1 WHERE id = $1 AND status = 'awaiting_payment'", [o.id]);
      await client.query("UPDATE payment_events SET processing_status = 'needs_reconciliation' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'needs_reconciliation';
    }

    await client.query("UPDATE payment_attempts SET status = 'settled', settled_at = now() WHERE id = $1", [pa.id]);
    // A late event on an already-paid order is acknowledged without regressing state.
    if (o.status !== 'awaiting_payment') {
      await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
      return 'processed';
    }

    await fulfillOrder(client, o.id, o.buyer_id, event.providerEventId);
    await client.query("UPDATE payment_events SET processing_status = 'processed' WHERE provider = $1 AND provider_event_id = $2", [provider, event.providerEventId]);
    return 'processed';
  });
}

export async function commerceRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, store, payment } = app.deps;

  async function loadPlanForPurchase(templateId: string, planId: string): Promise<{ plan: PublicPlan; versionId: string } | null> {
    const { rows } = await db.query<{ published_version_id: string | null }>(
      "SELECT published_version_id FROM templates WHERE id = $1 AND status = 'published'",
      [templateId],
    );
    if (!rows[0]?.published_version_id) return null;
    const plans = await loadActivePlans(db, templateId, config.currency);
    const plan = plans.find((p) => p.id === planId);
    return plan ? { plan, versionId: rows[0].published_version_id } : null;
  }

  // POST /quotes — backend prices the plan; the quote is bound to the buyer and expires.
  app.post<{ Body: { plan_id: string; template_id: string } }>(
    '/quotes',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['plan_id', 'template_id'], properties: { plan_id: { type: 'string', pattern: UUID.source }, template_id: { type: 'string', pattern: UUID.source } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const found = await loadPlanForPurchase(request.body.template_id, request.body.plan_id);
      if (!found) throw errors.notFound();
      const { subtotal, lines } = computeCharge(found.plan);
      const snapshot = {
        template_id: request.body.template_id,
        version_id: found.versionId,
        plan_id: found.plan.id,
        plan_code: found.plan.code,
        plan_name: found.plan.name,
        deployment_mode: found.plan.deployment_mode,
        lines,
        limits: found.plan.limits,
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
          expires_at: rows[0]!.expires_at.toISOString(),
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>('/quotes/:id', async (request) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rows } = await db.query<{ buyer_id: string | null; currency: string; subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string; snapshot_json: { lines: QuoteLine[]; deployment_mode: string; plan_name: Record<string, string> }; expires_at: Date }>(
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
          const snap = q.snapshot_json as { template_id: string; version_id: string; plan_id: string; deployment_mode: string; plan_name: Record<string, string>; limits: Record<string, unknown> };
          const order = await client.query<{ id: string }>(
            `INSERT INTO orders (buyer_id, quote_id, currency, subtotal_minor, total_minor, locale, terms_version, payment_window_expires_at)
             VALUES ($1, $2, $3, $4, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
            [auth.userId, q.id, q.currency, q.total_minor, request.locale, request.body.terms_version, config.paymentWindowMinutes],
          );
          const orderId = order.rows[0]!.id;
          await client.query(
            `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, snap.template_id, snap.version_id, snap.plan_id, snap.deployment_mode, q.total_minor, { plan_name: snap.plan_name, updates_months: (snap.limits as { updates_months?: number }).updates_months ?? null, instance_limit: (snap.limits as { instance_limit?: number }).instance_limit ?? 1 }],
          );
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
        paid_at: o.paid_at?.toISOString() ?? null,
        payment_window_expires_at: o.payment_window_expires_at?.toISOString() ?? null,
        created_at: o.created_at.toISOString(),
      },
      meta: { request_id: request.id, revision: null },
    };
  });

  // Create a payment session with the configured provider (mock sandbox for now).
  app.post<{ Params: { id: string } }>('/orders/:id/payment-sessions', async (request, reply) => {
    const auth = requireUser(request);
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; buyer_id: string; status: string; total_minor: string; currency: string }>(
      'SELECT id, buyer_id, status, total_minor::text, currency FROM orders WHERE id = $1',
      [request.params.id],
    );
    const o = rows[0];
    if (!o || o.buyer_id !== auth.userId) throw errors.notFound();
    if (o.status !== 'awaiting_payment') throw errors.conflict('order.not_payable');
    const session = payment.createSession({ orderId: o.id, amountMinor: o.total_minor, currency: o.currency, returnUrl: `${config.portalOrigin}/checkout/orders/${o.id}/result`, expiresAt: new Date(Date.now() + config.paymentWindowMinutes * 60_000) });
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
    const { rows } = await db.query<{ id: string; provider: string; provider_ref: string | null; amount_minor: string; currency: string; status: string; created_at: Date }>(
      'SELECT id, provider, provider_ref, amount_minor::text, currency, status, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC',
      [request.params.id],
    );
    return { data: rows.map((r) => ({ id: r.id, provider: r.provider, provider_ref: r.provider_ref, amount_minor: r.amount_minor, currency: r.currency, status: r.status, created_at: r.created_at.toISOString() })), page: { next_cursor: null, has_more: false } };
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
  app.post('/payments/refund-webhooks/:provider', async (request, reply) => {
    const providerName = (request.params as { provider: string }).provider;
    if (providerName !== payment.name) throw errors.notFound();
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
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
  // Note: the mock re-serialises the parsed JSON deterministically; a real provider needs the
  // exact raw bytes (a raw-body capture) wired in at the integration milestone.
  app.post('/payments/webhooks/:provider', async (request: FastifyRequest, reply) => {
    const providerName = (request.params as { provider: string }).provider;
    if (providerName !== payment.name) throw errors.notFound();
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
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
    const { rows } = await db.query<{ id: string; mode: string; status: string; instance_limit: number; updates_until: Date | null; template_id: string; version_id: string; slug: string; semver: string; created_at: Date }>(
      `SELECT e.id, e.mode, e.status, e.instance_limit, e.updates_until, e.template_id, e.version_id, t.slug, v.semver, e.created_at
       FROM entitlements e JOIN templates t ON t.id = e.template_id JOIN template_versions v ON v.id = e.version_id
       WHERE e.user_id = $1 ORDER BY e.created_at DESC`,
      [auth.userId],
    );
    return {
      data: rows.map((e) => ({
        id: e.id,
        mode: e.mode,
        status: e.status,
        instance_limit: e.instance_limit,
        updates_until: e.updates_until?.toISOString() ?? null,
        template: { id: e.template_id, slug: e.slug },
        version: { id: e.version_id, semver: e.semver },
        created_at: e.created_at.toISOString(),
      })),
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
