import type { FastifyInstance } from 'fastify';
import { tx, writeAudit } from '@3t/core';
import { creditWallet, debitWallet, pointsToVnd, walletBalance } from '../lib/partner-wallet.ts';
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
      `SELECT p.id, p.code, p.display_name, p.channel, p.domain, p.status, p.review_reason, p.created_at, u.email_normalized AS owner_email
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

  // --- Partner wallet oversight (docs/06 §11) ---
  app.get<{ Params: { id: string } }>('/partners/:id/wallet', async (request) => {
    requirePermission(request, 'partner:read');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const balance = await walletBalance(db, request.params.id);
    const entries = await db.query(
      'SELECT id, kind, amount_points::text, balance_after_points::text, note, created_at FROM partner_wallet_entries WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 100',
      [request.params.id],
    );
    const topups = await db.query(
      'SELECT id, amount_points::text, paid_amount_minor::text, code, status, created_at, paid_at FROM partner_topups WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 50',
      [request.params.id],
    );
    const sales = await db.query(
      'SELECT id, order_id, external_reference, listed_minor::text, cut_bps, cost_minor::text, price_minor::text, cost_points::text, price_points::text, status, created_at FROM partner_wallet_sales WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 50',
      [request.params.id],
    );
    return { data: { balance_points: balance.toString(), entries: entries.rows, topups: topups.rows, sales: sales.rows } };
  });

  // Staff confirms a top-up that arrived without a hub webhook (the
  // no-hub fallback, same as manual payment confirmation).
  app.post<{ Params: { id: string; topupId: string } }>('/partners/:id/wallet/topups/:topupId/confirm', async (request, reply) => {
    const auth = requirePermission(request, 'partner:manage');
    if (!UUID.test(request.params.id) || !UUID.test(request.params.topupId)) throw errors.notFound();
    const result = await tx(db, async (client) => {
      const topup = await client.query<{ id: string; partner_id: string; amount_points: string; code: string }>(
        "SELECT id, partner_id, amount_points::text, code FROM partner_topups WHERE id = $1 AND partner_id = $2 AND status = 'pending' FOR UPDATE",
        [request.params.topupId, request.params.id],
      );
      if (!topup.rows[0]) return null;
      const t = topup.rows[0]!;
      await client.query("UPDATE partner_topups SET status = 'paid', paid_amount_minor = $2, paid_at = now() WHERE id = $1", [t.id, pointsToVnd(BigInt(t.amount_points)).toString()]);
      const balance = await creditWallet(client, t.partner_id, BigInt(t.amount_points), 'topup', 'partner_topup', t.id, `manual:${t.code}`);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'partner.wallet_topup_confirmed', resourceType: 'partner_topup', resourceId: t.id, traceId: request.id });
      return { id: t.id, status: 'paid', balance_points: balance.toString() };
    });
    if (!result) throw errors.conflict('topup.not_pending');
    return reply.status(200).send({ data: result });
  });

  // Staff wallet adjustment: a ledger entry with a reason, never an edit.
  app.post<{ Params: { id: string }; Body: { amount_points: string; note: string } }>(
    '/partners/:id/wallet/adjust',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['amount_points', 'note'], properties: { amount_points: { type: 'string', pattern: '^-?[0-9]+$' }, note: { type: 'string', minLength: 3, maxLength: 500 } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'partner:manage');
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const amount = BigInt(request.body.amount_points);
      if (amount === 0n) throw errors.validation([{ field: 'amount_points', code: 'must_be_nonzero' }]);
      const result = await tx(db, async (client) => {
        const partner = await client.query<{ id: string }>('SELECT id FROM partner_accounts WHERE id = $1', [request.params.id]);
        if (!partner.rows[0]) return null;
        let balance: bigint;
        if (amount > 0n) {
          balance = await creditWallet(client, request.params.id, amount, 'adjustment', 'admin', null, request.body.note);
        } else {
          const debit = await debitWallet(client, request.params.id, -amount, 'adjustment', 'admin', null, request.body.note);
          if (!debit.ok) throw errors.validation([{ field: 'amount_points', code: 'partner.insufficient_balance' }]);
          balance = debit.balance;
        }
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'partner.wallet_adjusted', resourceType: 'partner', resourceId: request.params.id, traceId: request.id });
        return { balance_points: balance.toString() };
      });
      if (!result) throw errors.notFound();
      return reply.status(200).send({ data: result });
    },
  );

  // v32: partner discount % per category — overrides the policy's global
  // cut for templates in that category when a wallet sale deducts.
  app.get('/partner-category-discounts', async (request) => {
    requirePermission(request, 'partner:read');
    const { rows } = await db.query(
      `SELECT c.id AS category_id, c.code, d.discount_bps
         FROM template_categories c
         LEFT JOIN partner_category_discounts d ON d.category_id = c.id
        ORDER BY c.code`,
    );
    return { data: rows };
  });

  app.post<{ Body: { items: { category_id: string; discount_bps: number | null }[] } }>(
    '/partner-category-discounts',
    {
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['items'],
          properties: {
            items: {
              type: 'array', maxItems: 200,
              items: {
                type: 'object', additionalProperties: false, required: ['category_id', 'discount_bps'],
                properties: { category_id: { type: 'string' }, discount_bps: { type: ['integer', 'null'], minimum: 0, maximum: 9000 } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'partner:manage');
      for (const item of request.body.items) {
        if (!UUID.test(item.category_id)) throw errors.validation([{ field: 'items.category_id', code: 'invalid' }]);
      }
      await tx(db, async (client) => {
        for (const item of request.body.items) {
          if (item.discount_bps === null) {
            await client.query('DELETE FROM partner_category_discounts WHERE category_id = $1', [item.category_id]);
          } else {
            await client.query(
              `INSERT INTO partner_category_discounts (category_id, discount_bps) VALUES ($1, $2)
               ON CONFLICT (category_id) DO UPDATE SET discount_bps = EXCLUDED.discount_bps`,
              [item.category_id, item.discount_bps],
            );
          }
        }
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'partner.category_discounts_updated', resourceType: 'partner_policy', resourceId: null, traceId: request.id });
      });
      return reply.status(200).send({ data: { updated: request.body.items.length } });
    },
  );

  // Partner policies: commission rate + the reseller wallet cut.
  app.get('/partner-policies', async (request) => {
    requirePermission(request, 'partner:read');
    const { rows } = await db.query(
      'SELECT id, code, rate_bps, reseller_discount_bps, hold_days, payout_min_minor::text, applies_to, active FROM partner_policies ORDER BY created_at',
    );
    return { data: rows };
  });

  app.post<{ Params: { id: string }; Body: { rate_bps?: number; reseller_discount_bps?: number; hold_days?: number; payout_min_minor?: string } }>(
    '/partner-policies/:id',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { rate_bps: { type: 'integer', minimum: 0, maximum: 10000 }, reseller_discount_bps: { type: 'integer', minimum: 0, maximum: 9000 }, hold_days: { type: 'integer', minimum: 0, maximum: 365 }, payout_min_minor: { type: 'string', pattern: '^[0-9]+$' } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'partner:manage');
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const { rows } = await db.query<{ id: string }>(
        `UPDATE partner_policies SET
           rate_bps = COALESCE($2, rate_bps),
           reseller_discount_bps = COALESCE($3, reseller_discount_bps),
           hold_days = COALESCE($4, hold_days),
           payout_min_minor = COALESCE($5::bigint, payout_min_minor)
         WHERE id = $1 RETURNING id`,
        [request.params.id, request.body.rate_bps ?? null, request.body.reseller_discount_bps ?? null, request.body.hold_days ?? null, request.body.payout_min_minor ?? null],
      );
      if (!rows[0]) throw errors.notFound();
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'partner.policy_updated', resourceType: 'partner_policy', resourceId: request.params.id, traceId: request.id });
      return reply.status(200).send({ data: { id: request.params.id, updated: true } });
    },
  );
}
