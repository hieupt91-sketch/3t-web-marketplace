import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { tx, writeAudit } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { fulfillOrder, recomputeOrderRefundStatus } from './commerce.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

/**
 * M4 close: refunds + reconciliation (A12, AT-56).
 * - Staff approve/reject buyer refund requests (payment:refund). Approval only creates a
 *   provider refund reference; money moves only via a verified provider refund event.
 * - Reconciliation lists orders stuck in needs_reconciliation plus unmatched/ignored
 *   provider events. Resolving never edits raw events; it records an audit entry.
 */
export async function adminCommerceRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // A12: reconciliation queue — orders needing attention + unmatched/ignored events.
  app.get('/reconciliation', async (request) => {
    requirePermission(request, 'payment:read');
    const orders = await db.query<{ id: string; buyer_id: string; total_minor: string; currency: string; created_at: Date }>(
      "SELECT id, buyer_id, total_minor::text, currency, created_at FROM orders WHERE status = 'needs_reconciliation' ORDER BY created_at ASC LIMIT 100",
    );
    const events = await db.query<{ id: string; provider: string; provider_event_id: string; order_id: string | null; processing_status: string; received_at: Date }>(
      `SELECT id, provider, provider_event_id, order_id, processing_status, received_at FROM payment_events
       WHERE processing_status IN ('needs_reconciliation', 'ignored') ORDER BY received_at DESC LIMIT 100`,
    );
    const attempts = await db.query<{ order_id: string; provider_ref: string | null; amount_minor: string; currency: string; status: string }>(
      `SELECT order_id, provider_ref, amount_minor::text, currency, status FROM payment_attempts
       WHERE order_id IN (SELECT id FROM orders WHERE status = 'needs_reconciliation') ORDER BY created_at DESC`,
    );
    return {
      data: {
        orders: orders.rows.map((o) => ({ id: o.id, buyer_id: o.buyer_id, total_minor: o.total_minor, currency: o.currency, created_at: o.created_at.toISOString(), attempts: attempts.rows.filter((a) => a.order_id === o.id) })),
        unmatched_events: events.rows.map((e) => ({ id: e.id, provider: e.provider, provider_event_id: e.provider_event_id, order_id: e.order_id, processing_status: e.processing_status, received_at: e.received_at.toISOString() })),
      },
    };
  });

  // Resolve a needs_reconciliation order: 'paid' fulfils it (entitlements, once, via the
  // same fulfillOrder used by payment settlement); 'cancelled' closes it without fulfilment.
  app.post<{ Params: { id: string }; Body: { resolution: string; reason: string } }>(
    '/reconciliation/orders/:id/resolve',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['resolution', 'reason'], properties: { resolution: { type: 'string', enum: ['paid', 'cancelled'] }, reason: { type: 'string', minLength: 3, maxLength: 500 } } } } },
    async (request) => {
      const auth = requirePermission(request, 'payment:confirm');
      assertId(request.params.id);
      await tx(db, async (client) => {
        const order = await client.query<{ status: string; buyer_id: string }>(
          "SELECT status, buyer_id FROM orders WHERE id = $1 FOR UPDATE",
          [request.params.id],
        );
        const o = order.rows[0];
        if (!o) throw errors.notFound();
        if (o.status !== 'needs_reconciliation') throw errors.conflict('reconciliation.not_pending');
        if (request.body.resolution === 'paid') {
          await fulfillOrder(client, request.params.id, o.buyer_id, request.id);
        } else {
          await client.query("UPDATE orders SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1", [request.params.id]);
        }
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'reconciliation.resolved', resourceType: 'order', resourceId: request.params.id, traceId: request.id, diff: { resolution: request.body.resolution, reason: request.body.reason } });
      });
      return { data: { id: request.params.id, resolution: request.body.resolution } };
    },
  );

  // Staff refund queue.
  app.get<{ Querystring: { status?: string } }>('/refunds', async (request) => {
    requirePermission(request, 'payment:read');
    const status = request.query.status;
    const where = status && ['requested', 'pending', 'confirmed', 'failed', 'rejected'].includes(status) ? 'WHERE r.status = $1' : '';
    const params = where ? [status] : [];
    const { rows } = await db.query<{ id: string; order_id: string; buyer_id: string; amount_minor: string; currency: string; status: string; reason: string; created_at: Date }>(
      `SELECT r.id, r.order_id, r.buyer_id, r.amount_minor::text, r.currency, r.status, r.reason, r.created_at
       FROM refunds r ${where} ORDER BY r.created_at DESC LIMIT 100`,
      params,
    );
    return { data: rows.map((r) => ({ id: r.id, order_id: r.order_id, buyer_id: r.buyer_id, amount_minor: r.amount_minor, currency: r.currency, status: r.status, reason: r.reason, created_at: r.created_at.toISOString() })), page: { next_cursor: null, has_more: false } };
  });

  // Approve: creates the provider refund reference; settlement still needs a verified event.
  app.post<{ Params: { id: string } }>('/refunds/:id/approve', async (request) => {
    const auth = requirePermission(request, 'payment:refund');
    assertId(request.params.id);
    const result = await tx(db, async (client) => {
      const refund = await client.query<{ id: string; order_id: string; status: string }>(
        'SELECT id, order_id, status FROM refunds WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const r = refund.rows[0];
      if (!r) throw errors.notFound();
      if (r.status !== 'requested') throw errors.conflict('refund.not_requested');
      const providerRef = `mockrefund_${randomUUID()}`;
      await client.query("UPDATE refunds SET status = 'pending', provider_ref = $2, decided_by = $3, decided_at = now() WHERE id = $1", [r.id, providerRef, auth.userId]);
      await recomputeOrderRefundStatus(client, r.order_id);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'refund.approved', resourceType: 'refund', resourceId: r.id, traceId: request.id });
      return providerRef;
    });
    return { data: { id: request.params.id, status: 'pending', provider_ref: result } };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/refunds/:id/reject',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } } },
    async (request) => {
      const auth = requirePermission(request, 'payment:refund');
      assertId(request.params.id);
      await tx(db, async (client) => {
        const refund = await client.query<{ id: string; order_id: string; status: string }>(
          'SELECT id, order_id, status FROM refunds WHERE id = $1 FOR UPDATE',
          [request.params.id],
        );
        const r = refund.rows[0];
        if (!r) throw errors.notFound();
        if (r.status !== 'requested') throw errors.conflict('refund.not_requested');
        await client.query("UPDATE refunds SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1", [r.id, auth.userId]);
        await recomputeOrderRefundStatus(client, r.order_id);
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'refund.rejected', resourceType: 'refund', resourceId: r.id, traceId: request.id, diff: { reason: request.body.reason ?? '' } });
      });
      return { data: { id: request.params.id, status: 'rejected' } };
    },
  );

}
