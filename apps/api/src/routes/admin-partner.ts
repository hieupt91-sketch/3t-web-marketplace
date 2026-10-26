import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { emitPartnerEvent } from '../lib/partner-webhooks.ts';
import { requireStepUp } from '../lib/step-up.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function adminPartnerRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // A20: partner review queue.
  app.get<{ Querystring: { status?: string } }>('/partners', async (request) => {
    requirePermission(request, 'partner:read');
    const status = request.query.status;
    const { rows } = await db.query(
      `SELECT p.id, p.code, p.display_name, p.channel, p.domain, p.status, p.review_reason, p.created_at, u.email AS owner_email
       FROM partner_accounts p JOIN users u ON u.id = p.user_id
       WHERE $1::text IS NULL OR p.status = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [status ?? null],
    );
    return { data: rows };
  });

  app.get<{ Params: { id: string } }>('/partners/:id', async (request) => {
    requirePermission(request, 'partner:read');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT * FROM partner_accounts WHERE id = $1',
      [request.params.id],
    );
    if (!rows[0]) throw errors.notFound();
    return { data: rows[0] };
  });

  // Approve / reject / suspend. Suspending blocks new API calls and checkout
  // sessions but never revokes already-bought customers' rights (AT-41): orders,
  // entitlements, commissions and sites are untouched by this transition.
  app.post<{ Params: { id: string }; Body: { decision: string; reason?: string } }>(
    '/partners/:id/review',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { type: 'string', enum: ['approve', 'reject', 'suspend', 'reactivate'] }, reason: { type: 'string', maxLength: 500 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'partner:manage');
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const next = { approve: 'active', reject: 'rejected', suspend: 'suspended', reactivate: 'active' }[request.body.decision]!;
      const { rowCount } = await db.query(
        `UPDATE partner_accounts SET status = $2, reviewed_by = $3, review_reason = $4 WHERE id = $1`,
        [request.params.id, next, auth.userId, request.body.reason ?? ''],
      );
      if (rowCount === 0) throw errors.notFound();
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: `partner.${request.body.decision}`, resourceType: 'partner', resourceId: request.params.id, traceId: request.params.id });
      return reply.status(200).send({ data: { id: request.params.id, status: next } });
    },
  );

  // Staff adjustment: a separate entry, never an edit of history (docs/06 §7).
  app.post<{ Params: { id: string }; Body: { amount_minor: string; reason: string } }>(
    '/partners/:id/adjustments',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['amount_minor', 'reason'], properties: { amount_minor: { type: 'string', pattern: '^-?[0-9]+$' }, reason: { type: 'string', minLength: 3, maxLength: 500 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'partner:manage');
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const partner = await db.query('SELECT id FROM partner_accounts WHERE id = $1', [request.params.id]);
      if (!partner.rows[0]) throw errors.notFound();
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO commission_entries (partner_id, order_id, order_item_id, kind, status, amount_minor, reason, eligible_at)
         SELECT $1, o.id, i.id, 'adjustment', 'eligible', $2, $3, now()
         FROM orders o JOIN order_items i ON i.order_id = o.id
         JOIN attributions a ON a.order_id = o.id WHERE a.partner_id = $1 ORDER BY o.created_at DESC LIMIT 1`,
        [request.params.id, request.body.amount_minor, request.body.reason],
      );
      if (!rows[0]) throw errors.conflict('partner.no_order_for_adjustment');
      return reply.status(201).send({ data: { id: rows[0].id } });
    },
  );

  // A21: payouts with approver/settler separation; no paid without evidence.
  app.get('/payouts', async (request) => {
    requirePermission(request, 'payout:read');
    const { rows } = await db.query(
      `SELECT pr.id, pr.partner_id, pa.display_name AS partner_name, pr.amount_minor::text, pr.status, pr.evidence_ref, pr.created_at
       FROM payout_requests pr JOIN partner_accounts pa ON pa.id = pr.partner_id ORDER BY pr.created_at DESC LIMIT 100`,
    );
    return { data: rows };
  });

  app.post<{ Params: { id: string } }>('/payouts/:id/approve', async (request, reply) => {
    const auth = requirePermission(request, 'payout:approve');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const { rowCount } = await db.query(
      `UPDATE payout_requests SET status = 'approved', approved_by = $2 WHERE id = $1 AND status = 'requested'`,
      [request.params.id, auth.userId],
    );
    if (rowCount === 0) throw errors.conflict('payout.not_requested');
    return reply.status(200).send({ data: { id: request.params.id, status: 'approved' } });
  });

  app.post<{ Params: { id: string }; Body: { evidence_ref: string } }>(
    '/payouts/:id/settle',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['evidence_ref'], properties: { evidence_ref: { type: 'string', minLength: 3, maxLength: 500 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'payout:settle');
      await requireStepUp(db, auth);
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const row = await db.query<{ status: string; approved_by: string | null; partner_id: string; amount_minor: string }>(
        'SELECT status, approved_by, partner_id, amount_minor::text FROM payout_requests WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const payout = row.rows[0];
      if (!payout) throw errors.notFound();
      if (payout.status !== 'approved') throw errors.conflict('payout.not_approved');
      if (payout.approved_by === auth.userId) throw errors.forbidden('payout.same_actor');
      await db.query(`UPDATE payout_requests SET status = 'paid', settled_by = $2, evidence_ref = $3 WHERE id = $1`, [request.params.id, auth.userId, request.body.evidence_ref]);
      await emitPartnerEvent(db, payout.partner_id, { type: 'payout.paid', data: { payout_id: request.params.id, amount_minor: payout.amount_minor, evidence_ref: request.body.evidence_ref } });
      return reply.status(200).send({ data: { id: request.params.id, status: 'paid' } });
    },
  );

  // Failed payout releases the reservation exactly once: allocations only count
  // while the payout is in an active state, so moving to failed frees them.
  app.post<{ Params: { id: string } }>('/payouts/:id/fail', async (request, reply) => {
    requirePermission(request, 'payout:settle');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const { rowCount } = await db.query(
      `UPDATE payout_requests SET status = 'failed' WHERE id = $1 AND status IN ('requested', 'approved', 'processing')`,
      [request.params.id],
    );
    if (rowCount === 0) throw errors.conflict('payout.not_active');
    return reply.status(200).send({ data: { id: request.params.id, status: 'failed' } });
  });
}
