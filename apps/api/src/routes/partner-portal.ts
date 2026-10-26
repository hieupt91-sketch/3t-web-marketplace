import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getSetting, hashToken, tx, writeAudit } from '@3t/core';
import { requirePermission, requireUser } from '../app.ts';
import { errors } from '../errors.ts';
import { partnerBalance } from '../lib/partner-ledger.ts';
import { requireStepUp } from '../lib/step-up.ts';
import { assertPublicWebhookUrl, decryptWebhookSecret, encryptWebhookSecret, sendWebhookDelivery } from '../lib/partner-webhooks.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALL_SCOPES = ['catalog:read', 'demo:link', 'checkout:create', 'orders:read', 'commissions:read', 'events:read'];
const WEBHOOK_EVENTS = ['order.created', 'order.paid', 'order.cancelled', 'fulfillment.ready', 'fulfillment.failed', 'refund.settled', 'commission.eligible', 'commission.reversed', 'payout.paid', 'payout.failed'];

async function ownPartner(db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> }, userId: string) {
  const { rows } = await db.query<{ id: string; status: string; code: string; policy_id: string | null }>(
    'SELECT id, status, code, policy_id FROM partner_accounts WHERE user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

export async function partnerPortalRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  // R01: apply (verified users only); rejected applications can be resubmitted.
  app.post<{ Body: { display_name: string; channel: string; domain: string; description?: string } }>(
    '/partner/apply',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['display_name', 'channel', 'domain'], properties: { display_name: { type: 'string', minLength: 1, maxLength: 120 }, channel: { type: 'string', minLength: 1, maxLength: 500 }, domain: { type: 'string', minLength: 1, maxLength: 253 }, description: { type: 'string', maxLength: 2000 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const user = await db.query<{ verified_at: Date | null }>('SELECT verified_at FROM users WHERE id = $1', [auth.userId]);
      if (!user.rows[0]?.verified_at) throw errors.forbidden('partner.not_verified');
      const existing = await ownPartner(db, auth.userId);
      if (existing && existing.status !== 'rejected') throw errors.conflict('partner.already_applied');
      const code = `p_${randomBytes(6).toString('hex')}`;
      const termsVersion = (await getSetting<{ current: string }>(db, 'terms.version').catch(() => null))?.current ?? 'terms-2026-10';
      if (existing) {
        await db.query(
          `UPDATE partner_accounts SET display_name = $2, channel = $3, domain = $4, description = $5, status = 'pending', terms_version = $6, review_reason = '' WHERE id = $1`,
          [existing.id, request.body.display_name, request.body.channel, request.body.domain, request.body.description ?? '', termsVersion],
        );
        return reply.status(200).send({ data: { id: existing.id, status: 'pending' } });
      }
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO partner_accounts (user_id, code, display_name, channel, domain, description, status, terms_version)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
        [auth.userId, code, request.body.display_name, request.body.channel, request.body.domain, request.body.description ?? '', termsVersion],
      );
      return reply.status(201).send({ data: { id: rows[0]!.id, status: 'pending' } });
    },
  );

  app.get('/partner/account', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, code, display_name, channel, domain, description, status, locale, timezone, return_domains, review_reason, created_at FROM partner_accounts WHERE id = $1',
      [partner.id],
    );
    const balance = partner.status === 'active' ? await partnerBalance(db, partner.id) : null;
    return { data: { ...rows[0], balance } };
  });

  // Buyer claim + order from a partner checkout session (docs/06 §3 steps 6–7).
  // The claim token proves the buyer followed the partner's checkout link; the
  // buyer must be the authenticated user (AT-35: a partner cannot claim for a buyer).
  app.post<{ Params: { id: string }; Body: { claim_token: string } }>(
    '/partner/checkout-sessions/:id/claim',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['claim_token'], properties: { claim_token: { type: 'string', minLength: 1 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (!UUID.test(request.params.id)) throw errors.notFound();
      const { rows } = await db.query<{ claim_token_hash: string | null; status: string; expires_at: Date; quote_id: string; partner_id: string }>(
        'SELECT claim_token_hash, status, expires_at, quote_id, partner_id FROM checkout_sessions WHERE id = $1',
        [request.params.id],
      );
      const session = rows[0];
      if (!session || session.status !== 'awaiting_buyer' || new Date(session.expires_at) <= new Date()) throw errors.notFound();
      if (hashToken(request.body.claim_token).toString('hex') !== session.claim_token_hash) throw errors.forbidden('partner.claim_denied');
      await db.query(`UPDATE checkout_sessions SET status = 'claimed', buyer_id = $2 WHERE id = $1`, [request.params.id, auth.userId]);
      return reply.status(200).send({ data: { id: request.params.id, status: 'claimed', quote_id: session.quote_id, partner_id: session.partner_id } });
    },
  );

  // Order from a claimed session: attribution is fixed at order creation (docs/06 §6).
  app.post<{ Params: { id: string } }>('/partner/checkout-sessions/:id/order', async (request, reply) => {
    const auth = requireUser(request);
    if (!UUID.test(request.params.id)) throw errors.notFound();
    return tx(db, async (client) => {
      const session = await client.query<{ partner_id: string; quote_id: string; status: string; expires_at: Date; buyer_id: string | null; order_id: string | null }>(
        'SELECT partner_id, quote_id, status, expires_at, buyer_id, order_id FROM checkout_sessions WHERE id = $1 FOR UPDATE',
        [request.params.id],
      );
      const s = session.rows[0];
      if (!s || s.buyer_id !== auth.userId || s.status !== 'claimed' || new Date(s.expires_at) <= new Date()) throw errors.notFound();
      if (s.order_id) return reply.status(200).send({ data: { order_id: s.order_id } });
      const quote = await client.query<{ snapshot_json: { template_id: string; version_id: string; plan_id: string; deployment_mode: string; lines: { label: string; interval: string; amount_minor: string }[]; limits: Record<string, unknown> }; total_minor: string; currency: string; expires_at: Date }>(
        'SELECT snapshot_json, total_minor::text, currency, expires_at FROM quotes WHERE id = $1',
        [s.quote_id],
      );
      const q = quote.rows[0];
      if (!q || new Date(q.expires_at) <= new Date()) throw errors.conflict('partner.quote_expired');
      const snap = q.snapshot_json;
      const policy = await client.query<{ rate_bps: number; hold_days: number; policy_version: string }>(
        `SELECT COALESCE(pp.rate_bps, 1000) AS rate_bps, COALESCE(pp.hold_days, 14) AS hold_days, COALESCE(pp.code, 'default') AS policy_version
         FROM partner_accounts pa LEFT JOIN partner_policies pp ON pp.id = pa.policy_id WHERE pa.id = $1`,
        [s.partner_id],
      );
      const pol = policy.rows[0]!;
      const terms = await getSetting<{ current: string }>(client, 'terms.version').catch(() => null);
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (buyer_id, quote_id, partner_id, currency, subtotal_minor, total_minor, terms_version, locale, status)
         VALUES ($1, $2, $3, $4, $5, $5, $6, 'vi', 'awaiting_payment') RETURNING id`,
        [auth.userId, s.quote_id, s.partner_id, q.currency, q.total_minor, terms?.current ?? 'terms-2026-10'],
      );
      const orderId = order.rows[0]!.id;
      for (const line of snap.lines) {
        await client.query(
          `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, snapshot_json, unit_price_minor, discount_minor, tax_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)`,
          [orderId, snap.template_id, snap.version_id, snap.plan_id, snap.deployment_mode, { plan_id: snap.plan_id, limits: snap.limits }, line.amount_minor],
        );
      }
      await client.query(
        'INSERT INTO attributions (order_id, partner_id, source, policy_snapshot) VALUES ($1, $2, $3, $4)',
        [orderId, s.partner_id, 'session', { rate_bps: pol.rate_bps, hold_days: pol.hold_days, policy_version: pol.policy_version }],
      );
      await client.query(`UPDATE checkout_sessions SET status = 'completed', order_id = $2 WHERE id = $1`, [request.params.id, orderId]);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'partner.order_created', resourceType: 'order', resourceId: orderId, traceId: request.params.id });
      return reply.status(201).send({ data: { order_id: orderId } });
    });
  });

  // R04 via session: signed referral link for the logged-in partner.
  app.post<{ Body: { template_slug: string; locale?: string; campaign?: string } }>(
    '/partner/demo-links',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_slug'], properties: { template_slug: { type: 'string', minLength: 1 }, locale: { type: 'string', enum: ['vi', 'en'] }, campaign: { type: 'string', maxLength: 100 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const partner = await ownPartner(db, auth.userId);
      if (!partner || partner.status !== 'active') throw errors.forbidden('partner.not_active');
      const template = await db.query<{ slug: string }>("SELECT slug FROM templates WHERE slug = $1 AND status = 'published'", [request.body.template_slug]);
      if (!template.rows[0]) throw errors.notFound();
      const locale = request.body.locale ?? 'vi';
      const sig = createHmac('sha256', config.partnerLinkSecret)
        .update(`${partner.code}:${request.body.template_slug}:${locale}`)
        .digest('hex')
        .slice(0, 32);
      const url = `${config.portalOrigin}/${locale}/templates/${request.body.template_slug}?ref=${partner.code}&sig=${sig}`;
      return reply.status(201).send({ data: { url, template_slug: request.body.template_slug, campaign: request.body.campaign ?? '' } });
    },
  );

  // Partner portal reads (own account only).
  app.get('/partner/orders', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_minor::text, o.currency, o.created_at FROM orders o
       JOIN attributions a ON a.order_id = o.id WHERE a.partner_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [partner.id],
    );
    return { data: rows };
  });

  app.get('/partner/commissions', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      `SELECT id, order_id, kind, status, amount_minor::text, base_minor::text, rate_bps, eligible_at, reason, created_at
       FROM commission_entries WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [partner.id],
    );
    return { data: { entries: rows, balance: await partnerBalance(db, partner.id) } };
  });

  app.get('/partner/balance', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    return { data: await partnerBalance(db, partner.id) };
  });

  // R07 payouts: amount <= available, at least the policy minimum; reservation is
  // atomic (AT-40) via the transaction + allocation rows.
  app.post<{ Body: { amount_minor: string; profile_id: string } }>(
    '/partner/payouts',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['amount_minor', 'profile_id'], properties: { amount_minor: { type: 'string', pattern: '^[0-9]+$' }, profile_id: { type: 'string', pattern: UUID.source } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const partner = await ownPartner(db, auth.userId);
      if (!partner || partner.status !== 'active') throw errors.forbidden('partner.not_active');
      const amount = BigInt(request.body.amount_minor);
      if (amount <= 0n) throw errors.badRequest('payout.amount_invalid');
      return tx(db, async (client) => {
        const profile = await client.query('SELECT id FROM payout_profiles WHERE id = $1 AND partner_id = $2', [request.body.profile_id, partner.id]);
        if (!profile.rows[0]) throw errors.notFound();
        const policy = await client.query<{ payout_min_minor: string }>(
          `SELECT COALESCE(pp.payout_min_minor, 500000)::text AS payout_min_minor FROM partner_accounts pa
           LEFT JOIN partner_policies pp ON pp.id = pa.policy_id WHERE pa.id = $1`,
          [partner.id],
        );
        if (amount < BigInt(policy.rows[0]!.payout_min_minor)) throw errors.badRequest('payout.below_minimum');
        const balance = await partnerBalance(client, partner.id);
        if (amount > BigInt(balance.available)) throw errors.conflict('payout.exceeds_available');
        const payout = await client.query<{ id: string }>(
          `INSERT INTO payout_requests (partner_id, profile_id, amount_minor) VALUES ($1, $2, $3) RETURNING id`,
          [partner.id, request.body.profile_id, amount.toString()],
        );
        const payoutId = payout.rows[0]!.id;
        // Allocate oldest eligible entries first (FIFO). An entry may be
        // partially allocated across payouts, so the remaining amount per
        // entry is its accrual minus allocations to active or paid payouts —
        // excluding the whole entry after a partial allocation would strand
        // the remainder (AT-40). Lock the rows, then re-read allocations so
        // concurrent payout requests serialize on the same entries.
        const remainingQuery = `
          SELECT e.id, (e.amount_minor - COALESCE(SUM(CASE WHEN p.status IN ('requested', 'approved', 'processing', 'paid') THEN a.amount_minor ELSE 0 END), 0))::text AS remaining_minor
          FROM commission_entries e
          LEFT JOIN payout_allocations a ON a.entry_id = e.id
          LEFT JOIN payout_requests p ON p.id = a.payout_id
          WHERE e.partner_id = $1 AND e.kind = 'accrued' AND e.eligible_at <= now()
          GROUP BY e.id, e.amount_minor, e.created_at
          HAVING (e.amount_minor - COALESCE(SUM(CASE WHEN p.status IN ('requested', 'approved', 'processing', 'paid') THEN a.amount_minor ELSE 0 END), 0)) > 0
          ORDER BY e.created_at ASC`;
        const candidates = await client.query<{ id: string }>(remainingQuery, [partner.id]);
        if (candidates.rows.length > 0) {
          await client.query('SELECT id FROM commission_entries WHERE id = ANY($1::uuid[]) FOR UPDATE', [candidates.rows.map((r) => r.id)]);
        }
        const entries = await client.query<{ id: string; remaining_minor: string }>(remainingQuery, [partner.id]);
        let remaining = amount;
        for (const entry of entries.rows) {
          if (remaining <= 0n) break;
          const take = remaining < BigInt(entry.remaining_minor) ? remaining : BigInt(entry.remaining_minor);
          await client.query('INSERT INTO payout_allocations (payout_id, entry_id, amount_minor) VALUES ($1, $2, $3)', [payoutId, entry.id, take.toString()]);
          remaining -= take;
        }
        if (remaining > 0n) throw errors.conflict('payout.exceeds_available');
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'partner.payout_requested', resourceType: 'payout', resourceId: payoutId, traceId: payoutId });
        return reply.status(201).send({ data: { id: payoutId, status: 'requested', amount_minor: amount.toString() } });
      });
    },
  );

  app.get('/partner/payouts', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, amount_minor::text, status, evidence_ref, created_at FROM payout_requests WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 100',
      [partner.id],
    );
    return { data: rows };
  });

  // R08 keys: secret shown exactly once at creation; stored only as a hash.
  app.post<{ Body: { scopes: string[]; expires_at?: string } }>(
    '/partner/api-keys',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['scopes'], properties: { scopes: { type: 'array', items: { type: 'string', enum: ALL_SCOPES }, minItems: 1 }, expires_at: { type: 'string' } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const partner = await ownPartner(db, auth.userId);
      if (!partner || partner.status !== 'active') throw errors.forbidden('partner.not_active');
      const secret = `3tp_${randomBytes(20).toString('hex')}`;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO partner_api_keys (partner_id, prefix, key_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [partner.id, secret.slice(0, 12), hashToken(secret).toString('hex'), request.body.scopes, request.body.expires_at ?? null],
      );
      return reply.status(201).send({ data: { id: rows[0]!.id, prefix: secret.slice(0, 12), secret, scopes: request.body.scopes } });
    },
  );

  app.get('/partner/api-keys', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, prefix, scopes, expires_at, revoked_at, last_used_at, created_at FROM partner_api_keys WHERE partner_id = $1 ORDER BY created_at DESC',
      [partner.id],
    );
    return { data: rows };
  });

  app.post<{ Params: { id: string } }>('/partner/api-keys/:id/revoke', async (request, reply) => {
    const auth = requireUser(request);
    await requireStepUp(db, auth);
    const partner = await ownPartner(db, auth.userId);
    if (!partner || !UUID.test(request.params.id)) throw errors.notFound();
    const { rowCount } = await db.query(
      `UPDATE partner_api_keys SET revoked_at = now() WHERE id = $1 AND partner_id = $2 AND revoked_at IS NULL`,
      [request.params.id, partner.id],
    );
    if (rowCount === 0) throw errors.notFound();
    return reply.status(200).send({ data: { id: request.params.id, revoked: true } });
  });

  // R09 webhooks: public HTTPS + SSRF guard; unverified endpoints get no real events.
  app.post<{ Body: { url: string; events: string[] } }>(
    '/partner/webhooks',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['url', 'events'], properties: { url: { type: 'string', minLength: 1, maxLength: 1000 }, events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS }, minItems: 1 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const partner = await ownPartner(db, auth.userId);
      if (!partner || partner.status !== 'active') throw errors.forbidden('partner.not_active');
      try {
        await assertPublicWebhookUrl(request.body.url, config.partnerWebhookAllowLoopback);
      } catch (err) {
        throw errors.badRequest((err as Error).message);
      }
      const secret = randomBytes(24).toString('hex');
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (partner_id, url, events, secret_hash, secret_enc, status) VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
        [partner.id, request.body.url, request.body.events, hashToken(secret).toString('hex'), encryptWebhookSecret(config.partnerWebhookKey, secret)],
      );
      return reply.status(201).send({ data: { id: rows[0]!.id, url: request.body.url, events: request.body.events, status: 'pending', secret } });
    },
  );

  app.get('/partner/webhooks', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, url, events, status, created_at FROM webhook_endpoints WHERE partner_id = $1 ORDER BY created_at DESC',
      [partner.id],
    );
    return { data: rows };
  });

  // Challenge/test: sends a signed test event immediately and marks verified on 2xx.
  app.post<{ Params: { id: string } }>('/partner/webhooks/:id/test', async (request, reply) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner || !UUID.test(request.params.id)) throw errors.notFound();
    const endpoint = await db.query<{ url: string; secret_enc: string | null }>(
      'SELECT url, secret_enc FROM webhook_endpoints WHERE id = $1 AND partner_id = $2',
      [request.params.id, partner.id],
    );
    if (!endpoint.rows[0] || !endpoint.rows[0].secret_enc) throw errors.notFound();
    const secret = decryptWebhookSecret(config.partnerWebhookKey, endpoint.rows[0].secret_enc);
    const delivery = await db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload_json)
       VALUES ($1, $2, 'webhook.test', $3::jsonb) RETURNING id`,
      [request.params.id, `evt_${randomBytes(8).toString('hex')}`, JSON.stringify({ id: `evt_test`, type: 'webhook.test', created_at: new Date().toISOString(), api_version: 'v1', data: {} })],
    );
    const outcome = await sendWebhookDelivery(db, delivery.rows[0]!.id, endpoint.rows[0]!.url, secret, config.partnerWebhookAllowLoopback);
    if (outcome === 'delivered') await db.query(`UPDATE webhook_endpoints SET status = 'verified' WHERE id = $1`, [request.params.id]);
    return reply.status(200).send({ data: { id: request.params.id, status: outcome === 'delivered' ? 'verified' : 'pending', delivery: outcome } });
  });

  app.get<{ Params: { id: string } }>('/partner/webhooks/:id/deliveries', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner || !UUID.test(request.params.id)) throw errors.notFound();
    const endpoint = await db.query('SELECT id FROM webhook_endpoints WHERE id = $1 AND partner_id = $2', [request.params.id, partner.id]);
    if (!endpoint.rows[0]) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, event_id, event_type, status, attempts, response_status, created_at FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 100',
      [request.params.id],
    );
    return { data: rows };
  });

  // Admin-triggered (re)send for a pending/failed delivery (ops retry path).
  app.post<{ Params: { id: string } }>('/partner/webhooks/deliveries/:id/send', async (request, reply) => {
    requirePermission(request, 'ops:execute');
    if (!UUID.test(request.params.id)) throw errors.notFound();
    const row = await db.query<{ url: string; secret_enc: string | null }>(
      `SELECT e.url, e.secret_enc FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1`,
      [request.params.id],
    );
    if (!row.rows[0] || !row.rows[0].secret_enc) throw errors.notFound();
    const outcome = await sendWebhookDelivery(db, request.params.id, row.rows[0].url, decryptWebhookSecret(config.partnerWebhookKey, row.rows[0].secret_enc), config.partnerWebhookAllowLoopback);
    return reply.status(200).send({ data: { id: request.params.id, delivery: outcome } });
  });

  // R12 settings: locale/timezone, return domains, payout profile (masked label only).
  app.post<{ Body: { locale?: string; timezone?: string; return_domains?: string[] } }>(
    '/partner/settings',
    { schema: { body: { type: 'object', additionalProperties: true, properties: { locale: { type: 'string', enum: ['vi', 'en'] }, timezone: { type: 'string', maxLength: 100 }, return_domains: { type: 'array', items: { type: 'string', maxLength: 253 } } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const partner = await ownPartner(db, auth.userId);
      if (!partner) throw errors.notFound();
      const domains = (request.body.return_domains ?? []).map((d) => d.toLowerCase());
      for (const d of domains) {
        if (d.includes('*') || d.includes('/')) throw errors.badRequest('partner.return_domain_invalid');
      }
      await db.query(
        `UPDATE partner_accounts SET locale = COALESCE($2, locale), timezone = COALESCE($3, timezone), return_domains = $4 WHERE id = $1`,
        [partner.id, request.body.locale ?? null, request.body.timezone ?? null, domains],
      );
      return reply.status(200).send({ data: { id: partner.id, return_domains: domains } });
    },
  );

  app.post<{ Body: { account_label: string } }>(
    '/partner/payout-profiles',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['account_label'], properties: { account_label: { type: 'string', minLength: 1, maxLength: 120 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const partner = await ownPartner(db, auth.userId);
      if (!partner) throw errors.notFound();
      // v1 stores only a masked label (e.g. "VCB ••1234"); full bank details
      // are handled out of band and never stored here (docs/06 §8).
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO payout_profiles (partner_id, account_label) VALUES ($1, $2) RETURNING id`,
        [partner.id, request.body.account_label],
      );
      return reply.status(201).send({ data: { id: rows[0]!.id, account_label: request.body.account_label } });
    },
  );

  app.get('/partner/payout-profiles', async (request) => {
    const auth = requireUser(request);
    const partner = await ownPartner(db, auth.userId);
    if (!partner) throw errors.notFound();
    const { rows } = await db.query(
      'SELECT id, account_label, version, created_at FROM payout_profiles WHERE partner_id = $1 ORDER BY created_at DESC',
      [partner.id],
    );
    return { data: rows };
  });
}
