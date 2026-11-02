import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSetting, hashToken, loadActivePlans, tx, type PublicPlan } from '@3t/core';
import { errors } from '../errors.ts';
import { idempotent } from '../lib/idempotency.ts';
import { partnerBalance } from '../lib/partner-ledger.ts';
import { creditWallet, debitWallet, pointsToVnd, resolvePartnerCostPoints, vndToPointsCeil, walletBalance } from '../lib/partner-wallet.ts';
import { checkDbRateLimit } from '../lib/rate-limit-store.ts';
import { computeCharge, processPaymentEvent } from './commerce.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPES = ['catalog:read', 'demo:link', 'checkout:create', 'orders:read', 'commissions:read', 'events:read', 'wallet:sale'] as const;

/** Per-key rate limits in the shared Postgres buckets (M7: multi-instance safe). */
async function checkRate(db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> }, keyId: string, kind: 'catalog' | 'mutation'): Promise<void> {
  const limit = kind === 'catalog' ? 120 : 30;
  const result = await checkDbRateLimit(db, `partner:${keyId}:${kind}`, limit, 60000);
  if (!result.allowed) throw errors.tooMany(result.retryAfterSeconds);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local?.slice(0, 1) ?? '*'}***@${domain}`;
}

export async function partnerV1Routes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!presented) throw errors.unauthenticated('partner.key_required');
    const prefix = presented.slice(0, 12);
    const candidates = await db.query<{ id: string; partner_id: string; key_hash: string; scopes: string[]; expires_at: Date | null; revoked_at: Date | null; status: string }>(
      `SELECT k.id, k.partner_id, k.key_hash, k.scopes, k.expires_at, k.revoked_at, p.status
       FROM partner_api_keys k JOIN partner_accounts p ON p.id = k.partner_id WHERE k.prefix = $1`,
      [prefix],
    );
    const presentedHash = hashToken(presented).toString('hex');
    let matched: (typeof candidates.rows)[number] | null = null;
    for (const row of candidates.rows) {
      if (row.key_hash.length === presentedHash.length && timingSafeEqual(Buffer.from(row.key_hash), Buffer.from(presentedHash))) {
        matched = row;
        break;
      }
    }
    if (!matched || matched.revoked_at || (matched.expires_at && new Date(matched.expires_at) <= new Date()) || matched.status !== 'active') {
      throw errors.unauthenticated('partner.key_invalid');
    }
    (request as unknown as { partner: { id: string; partnerId: string; scopes: string[] } }).partner = {
      id: matched.id,
      partnerId: matched.partner_id,
      scopes: matched.scopes,
    };
    await db.query('UPDATE partner_api_keys SET last_used_at = now() WHERE id = $1', [matched.id]);
  });

  function partnerOf(request: FastifyRequest): { id: string; partnerId: string; scopes: string[] } {
    return (request as unknown as { partner: { id: string; partnerId: string; scopes: string[] } }).partner;
  }
  async function requireScope(request: FastifyRequest, scope: string, kind: 'catalog' | 'mutation'): Promise<void> {
    const partner = partnerOf(request);
    if (!partner.scopes.includes(scope)) throw errors.forbidden('partner.scope_denied');
    await checkRate(db, partner.id, kind);
  }
  function assertId(id: string): void {
    if (!UUID.test(id)) throw errors.notFound();
  }

  // GET /catalog — published templates with starting prices + commission basis (R03).
  app.get<{ Querystring: { locale?: string; category?: string } }>('/catalog', async (request) => {
    await requireScope(request, 'catalog:read', 'catalog');
    const locale = request.query.locale === 'en' ? 'en' : 'vi';
    const { rows } = await db.query<{ id: string; slug: string; title: string | null; category_id: string | null; starting_price: string | null }>(
      `SELECT t.id, t.slug, t.category_id, COALESCE(rt.title, ft.title) AS title,
              (SELECT MIN(pp.amount_minor)::text FROM plan_prices pp JOIN plans pl ON pl.id = pp.plan_id
               WHERE pl.template_id = t.id AND pl.status = 'active' AND pp.currency = $1
                 AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())) AS starting_price
       FROM templates t
       LEFT JOIN template_translations rt ON rt.template_id = t.id AND rt.locale = $2 AND rt.status = 'published'
       LEFT JOIN template_translations ft ON ft.template_id = t.id AND ft.locale = 'vi' AND ft.status = 'published'
       WHERE t.status = 'published' ORDER BY t.created_at DESC LIMIT 100`,
      [config.currency, locale],
    );
    const policy = await db.query<{ rate_bps: number }>(
      `SELECT COALESCE(pp.rate_bps, 1000) AS rate_bps FROM partner_accounts pa
       LEFT JOIN partner_policies pp ON pp.id = pa.policy_id WHERE pa.id = $1`,
      [partnerOf(request).partnerId],
    );
    return { data: rows.map((r) => ({ ...r, commission_rate_bps: policy.rows[0]?.rate_bps ?? 1000, currency: config.currency })) };
  });

  // POST /demo-links — signed referral link; never exposes source/admin access (R04).
  app.post<{ Body: { template_slug: string; locale?: string; campaign?: string } }>(
    '/demo-links',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_slug'], properties: { template_slug: { type: 'string', minLength: 1 }, locale: { type: 'string', enum: ['vi', 'en'] }, campaign: { type: 'string', maxLength: 100 } } } } },
    async (request, reply) => {
      await requireScope(request, 'demo:link', 'mutation');
      const partner = await db.query<{ code: string }>('SELECT code FROM partner_accounts WHERE id = $1', [partnerOf(request).partnerId]);
      const template = await db.query<{ slug: string }>("SELECT slug FROM templates WHERE slug = $1 AND status = 'published'", [request.body.template_slug]);
      if (!template.rows[0]) throw errors.notFound();
      const locale = request.body.locale ?? 'vi';
      const sig = createHmac('sha256', config.partnerLinkSecret)
        .update(`${partner.rows[0]!.code}:${request.body.template_slug}:${locale}`)
        .digest('hex')
        .slice(0, 32);
      const url = `${config.portalOrigin}/${locale}/templates/${request.body.template_slug}?ref=${partner.rows[0]!.code}&sig=${sig}`;
      return reply.status(201).send({ data: { url, template_slug: request.body.template_slug, campaign: request.body.campaign ?? '' } });
    },
  );

  // POST /quotes — backend-priced, partner-attributed, buyer bound later at claim (R04).
  app.post<{ Body: { template_id: string; plan_id: string } }>(
    '/quotes',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_id', 'plan_id'], properties: { template_id: { type: 'string', pattern: UUID.source }, plan_id: { type: 'string', pattern: UUID.source } } } } },
    async (request, reply) => {
      await requireScope(request, 'checkout:create', 'mutation');
      const { rows: t } = await db.query<{ published_version_id: string | null }>(
        "SELECT published_version_id FROM templates WHERE id = $1 AND status = 'published'",
        [request.body.template_id],
      );
      if (!t[0]?.published_version_id) throw errors.notFound();
      const plans: PublicPlan[] = await loadActivePlans(db, request.body.template_id, config.currency);
      const plan = plans.find((p) => p.id === request.body.plan_id);
      if (!plan) throw errors.notFound();
      const { subtotal, lines } = computeCharge(plan);
      const snapshot = { template_id: request.body.template_id, version_id: t[0].published_version_id, plan_id: plan.id, plan_code: plan.code, plan_name: plan.name, deployment_mode: plan.deployment_mode, lines, limits: plan.limits };
      const { rows } = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO quotes (partner_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at)
         VALUES ($1, $2, $3, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [partnerOf(request).partnerId, config.currency, subtotal.toString(), snapshot, 15],
      );
      return reply.status(201).send({ data: { id: rows[0]!.id, currency: config.currency, total_minor: subtotal.toString(), line_items: lines, deployment_mode: plan.deployment_mode, expires_at: rows[0]!.expires_at.toISOString() } });
    },
  );

  // POST /checkout-sessions — key identifies the partner; body may never set partner_id (AT-34).
  app.post<{ Body: { quote_id: string; external_reference: string; return_url?: string; locale?: string; campaign?: string } }>(
    '/checkout-sessions',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['quote_id', 'external_reference'], properties: { quote_id: { type: 'string', pattern: UUID.source }, external_reference: { type: 'string', minLength: 1, maxLength: 200 }, return_url: { type: 'string', maxLength: 1000 }, locale: { type: 'string', enum: ['vi', 'en'] }, campaign: { type: 'string', maxLength: 100 } } } } },
    async (request, reply) => {
      await requireScope(request, 'checkout:create', 'mutation');
      const partnerId = partnerOf(request).partnerId;
      const result = await idempotent(
        db,
        { key: request.headers['idempotency-key'], principal: `partner:${partnerId}`, route: 'POST /partner/v1/checkout-sessions', request: request.body },
        async (client) => {
          const existing = await client.query<{ id: string; quote_id: string; return_url: string; status: string; expires_at: Date }>(
            'SELECT id, quote_id, return_url, status, expires_at FROM checkout_sessions WHERE partner_id = $1 AND external_reference = $2',
            [partnerId, request.body.external_reference],
          );
          if (existing.rows[0]) {
            const e = existing.rows[0]!;
            // AT-36: retry with the same reference returns the same session; a
            // different quote/return for the same reference is a conflict.
            if (e.quote_id !== request.body.quote_id || e.return_url !== (request.body.return_url ?? '')) {
              throw errors.conflict('partner.reference_conflict');
            }
            return { status: 200, body: { data: { id: e.id, checkout_url: `${config.portalOrigin}/vi/checkout/partner/${e.id}`, status: e.status, expires_at: e.expires_at.toISOString() } } };
          }
          const quote = await client.query<{ partner_id: string | null; expires_at: Date }>(
            'SELECT partner_id, expires_at FROM quotes WHERE id = $1',
            [request.body.quote_id],
          );
          if (!quote.rows[0] || new Date(quote.rows[0].expires_at) <= new Date()) throw errors.notFound();
          if (quote.rows[0].partner_id && quote.rows[0].partner_id !== partnerId) throw errors.forbidden('partner.quote_denied');
          // Return URL allowlist (R12): exact host match against the partner's
          // registered domains; no wildcard subdomains, no arbitrary redirects.
          const returnUrl = request.body.return_url ?? '';
          if (returnUrl) {
            let host: string;
            try {
              const u = new URL(returnUrl);
              if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
              host = u.hostname.toLowerCase();
            } catch {
              throw errors.badRequest('partner.return_url_invalid');
            }
            const account = await client.query<{ return_domains: string[] }>('SELECT return_domains FROM partner_accounts WHERE id = $1', [partnerId]);
            if (!account.rows[0]!.return_domains.includes(host)) throw errors.forbidden('partner.return_url_denied');
          }
          const claimToken = randomBytes(24).toString('hex');
          const { rows } = await client.query<{ id: string; expires_at: Date }>(
            `INSERT INTO checkout_sessions (partner_id, quote_id, external_reference, return_url, campaign, locale, claim_token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8)) RETURNING id, expires_at`,
            [partnerId, request.body.quote_id, request.body.external_reference, returnUrl, request.body.campaign ?? '', request.body.locale ?? 'vi', hashToken(claimToken).toString('hex'), 30],
          );
          return {
            status: 201,
            body: {
              data: {
                id: rows[0]!.id,
                checkout_url: `${config.portalOrigin}/vi/checkout/partner/${rows[0]!.id}?token=${claimToken}`,
                status: 'awaiting_buyer',
                expires_at: rows[0]!.expires_at.toISOString(),
              },
            },
          };
        },
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>('/checkout-sessions/:id', async (request) => {
    await requireScope(request, 'checkout:create', 'catalog');
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; status: string; order_id: string | null; expires_at: Date }>(
      'SELECT id, status, order_id, expires_at FROM checkout_sessions WHERE id = $1 AND partner_id = $2',
      [request.params.id, partnerOf(request).partnerId],
    );
    if (!rows[0]) throw errors.notFound();
    return { data: rows[0] };
  });

  // Partner orders: own only, buyer masked, no downloads/source/admin access (AT-33, R05).
  app.get('/orders', async (request) => {
    await requireScope(request, 'orders:read', 'catalog');
    const { rows } = await db.query<{ id: string; status: string; total_minor: string; currency: string; buyer_email: string; created_at: Date }>(
      `SELECT o.id, o.status, o.total_minor::text, o.currency, u.email_normalized AS buyer_email, o.created_at
       FROM orders o JOIN users u ON u.id = o.buyer_id
       JOIN attributions a ON a.order_id = o.id WHERE a.partner_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [partnerOf(request).partnerId],
    );
    return { data: rows.map((r) => ({ ...r, buyer_email: maskEmail(r.buyer_email) })) };
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request) => {
    await requireScope(request, 'orders:read', 'catalog');
    assertId(request.params.id);
    const { rows } = await db.query<{ id: string; status: string; total_minor: string; currency: string; buyer_email: string }>(
      `SELECT o.id, o.status, o.total_minor::text, o.currency, u.email_normalized AS buyer_email
       FROM orders o JOIN users u ON u.id = o.buyer_id
       JOIN attributions a ON a.order_id = o.id WHERE o.id = $1 AND a.partner_id = $2`,
      [request.params.id, partnerOf(request).partnerId],
    );
    if (!rows[0]) throw errors.notFound();
    const items = await db.query<{ template_id: string; deployment_mode: string }>(
      'SELECT template_id, deployment_mode FROM order_items WHERE order_id = $1',
      [request.params.id],
    );
    return { data: { ...rows[0]!, buyer_email: maskEmail(rows[0]!.buyer_email), items: items.rows } };
  });

  app.get('/balance', async (request) => {
    await requireScope(request, 'commissions:read', 'catalog');
    return { data: await partnerBalance(db, partnerOf(request).partnerId) };
  });

  app.get('/commissions', async (request) => {
    await requireScope(request, 'commissions:read', 'catalog');
    const { rows } = await db.query(
      `SELECT id, order_id, kind, status, amount_minor::text, base_minor::text, rate_bps, eligible_at, reason, created_at
       FROM commission_entries WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [partnerOf(request).partnerId],
    );
    return { data: rows };
  });

  // Events the partner was actually sent (no internal events, R10 shape).
  app.get('/events', async (request) => {
    await requireScope(request, 'events:read', 'catalog');
    const { rows } = await db.query(
      `SELECT d.event_id, d.event_type, d.status, d.attempts, d.created_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE e.partner_id = $1 ORDER BY d.created_at DESC LIMIT 200`,
      [partnerOf(request).partnerId],
    );
    return { data: rows };
  });

  // Wallet balance + ledger for the calling partner (docs/06 §11).
  app.get('/wallet', async (request) => {
    await requireScope(request, 'commissions:read', 'catalog');
    const partnerId = partnerOf(request).partnerId;
    const balance = await walletBalance(db, partnerId);
    const entries = await db.query(
      'SELECT id, kind, amount_points::text, balance_after_points::text, note, created_at FROM partner_wallet_entries WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 50',
      [partnerId],
    );
    return { data: { balance_points: balance.toString(), balance_vnd: pointsToVnd(balance).toString(), currency: config.currency, entries: entries.rows } };
  });

  // POST /wallet-sales — direct reseller sale: the partner already
  // collected their own price from the buyer; the platform charges the
  // partner's wallet the cost (listed price minus the policy cut) and
  // fulfils the order to the buyer through the normal settlement path.
  app.post<{ Body: { template_id: string; plan_id: string; buyer_email: string; external_reference: string } }>(
    '/wallet-sales',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['template_id', 'plan_id', 'buyer_email', 'external_reference'], properties: { template_id: { type: 'string', pattern: UUID.source }, plan_id: { type: 'string', pattern: UUID.source }, buyer_email: { type: 'string', format: 'email', maxLength: 320 }, external_reference: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      await requireScope(request, 'wallet:sale', 'mutation');
      const partnerId = partnerOf(request).partnerId;
      const terms = await getSetting<{ current: string }>(db, 'terms.version').then((v) => v.current).catch(() => 'terms-2026-10');
      const phase1 = await tx(db, async (client) => {
          const existing = await client.query<{ id: string; order_id: string; status: string; price_minor: string; cost_minor: string; listed_minor: string; cut_bps: number; cost_points: string; price_points: string }>(
            'SELECT id, order_id, status, price_minor::text, cost_minor::text, listed_minor::text, cut_bps, cost_points::text, price_points::text FROM partner_wallet_sales WHERE partner_id = $1 AND external_reference = $2',
            [partnerId, request.body.external_reference],
          );
          if (existing.rows[0]) {
            const e = existing.rows[0]!;
            if (e.status !== 'completed') throw errors.conflict('partner.reference_conflict');
            const bal = await walletBalance(client, partnerId);
            return { status: 200, body: { data: { id: e.id, order_id: e.order_id, external_reference: request.body.external_reference, price_minor: e.price_minor, cost_minor: e.cost_minor, listed_minor: e.listed_minor, cut_bps: e.cut_bps, price_points: e.price_points, cost_points: e.cost_points, wallet_balance_points: bal.toString(), currency: config.currency, status: 'completed' } }, saleId: null as string | null, providerRef: null as string | null, price: 0n };
          }
          const buyer = await client.query<{ id: string }>(
            'SELECT id FROM users WHERE email_normalized = $1 AND verified_at IS NOT NULL',
            [request.body.buyer_email.trim().toLowerCase()],
          );
          if (!buyer.rows[0]) throw errors.validation([{ field: 'buyer_email', code: 'partner.buyer_not_found' }]);
          const tpl = await client.query<{ published_version_id: string | null }>(
            "SELECT published_version_id, category_id FROM templates WHERE id = $1 AND status = 'published' AND NOT hidden",
            [request.body.template_id],
          );
          if (!tpl.rows[0]?.published_version_id) throw errors.notFound();
          const plans: PublicPlan[] = await loadActivePlans(client, request.body.template_id, config.currency);
          const plan = plans.find((p) => p.id === request.body.plan_id);
          if (!plan) throw errors.notFound();
          const listed = BigInt(computeCharge(plan).subtotal);
          const policy = await client.query<{ reseller_discount_bps: number }>(
            `SELECT COALESCE(pp.reseller_discount_bps, 1000) AS reseller_discount_bps FROM partner_accounts pa
             LEFT JOIN partner_policies pp ON pp.id = pa.policy_id WHERE pa.id = $1`,
            [partnerId],
          );
          const cut = policy.rows[0]?.reseller_discount_bps ?? 1000;
          // The deduction is the platform's own partner price for this
          // plan — a fixed per-plan price when the owner set one, else
          // the policy cut. What the partner charges their customer is
          // their business and never enters this math.
          const resolved = await resolvePartnerCostPoints(client, { categoryId: (tpl.rows[0] as unknown as { category_id: string | null }).category_id, listedMinor: listed, policyCutBps: cut });
          const cost = resolved.exactMinor;
          const costPoints = resolved.points;
          const costSource = resolved.source;
          const resolvedCutBps = resolved.cutBps;
          const own = await client.query<{ amount_points: string }>(
            'SELECT amount_points::text FROM partner_prices WHERE partner_id = $1 AND plan_id = $2',
            [partnerId, plan.id],
          );
          // Prices live in points too: the partner's own point price, or
          // the listed price rounded up to whole points. The order total
          // in VND is always price_points x 1,000.
          const pricePoints = own.rows[0] ? BigInt(own.rows[0].amount_points) : vndToPointsCeil(listed);
          const price = pointsToVnd(pricePoints);
          const snapshot = { template_id: request.body.template_id, version_id: tpl.rows[0].published_version_id, plan_id: plan.id, plan_code: plan.code, plan_name: plan.name, deployment_mode: plan.deployment_mode, lines: computeCharge(plan).lines, limits: plan.limits, kind: 'wallet_sale' };
          const quote = await client.query<{ id: string }>(
            `INSERT INTO quotes (buyer_id, partner_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at)
             VALUES ($1, $2, $3, $4, $4, $5, now() + interval '15 minutes') RETURNING id`,
            [buyer.rows[0].id, partnerId, config.currency, price.toString(), snapshot],
          );
          const order = await client.query<{ id: string }>(
            `INSERT INTO orders (buyer_id, quote_id, currency, subtotal_minor, total_minor, locale, terms_version, payment_window_expires_at)
             VALUES ($1, $2, $3, $4, $4, 'vi', $5, now() + make_interval(mins => $6)) RETURNING id`,
            [buyer.rows[0].id, quote.rows[0]!.id, config.currency, price.toString(), terms, config.paymentWindowMinutes],
          );
          const orderId = order.rows[0]!.id;
          await client.query(
            `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, request.body.template_id, tpl.rows[0].published_version_id, plan.id, plan.deployment_mode, price.toString(), { plan_name: plan.name, updates_months: (plan.limits as { updates_months?: number }).updates_months ?? null, instance_limit: (plan.limits as { instance_limit?: number }).instance_limit ?? 1, storage_gb: 1 }],
          );
          const sale = await client.query<{ id: string }>(
            // 'pending' until phase-2 settlement completes it (audit
            // payments M3): a crash after this debit must not leave a
            // 'completed' row for an undelivered sale — the worker sweep
            // refunds stuck pending sales.
            `INSERT INTO partner_wallet_sales (partner_id, order_id, external_reference, buyer_id, plan_id, listed_minor, cut_bps, cost_minor, price_minor, cost_points, price_points, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending') RETURNING id`,
            [partnerId, orderId, request.body.external_reference, buyer.rows[0].id, plan.id, listed.toString(), resolvedCutBps, cost.toString(), price.toString(), costPoints.toString(), pricePoints.toString()],
          );
          const saleId = sale.rows[0]!.id;
          let debit: { ok: boolean; balance: bigint };
          try {
            debit = await debitWallet(client, partnerId, costPoints, 'sale_deduction', 'partner_wallet_sale', saleId, request.body.external_reference);
          } catch (err) {
            if (err instanceof Error && err.message === 'partner_wallet_negative') throw errors.validation([{ field: 'wallet', code: 'partner.insufficient_balance' }]);
            throw err;
          }
          if (!debit.ok) throw errors.validation([{ field: 'wallet', code: 'partner.insufficient_balance' }]);
          const providerRef = `WS${randomBytes(5).toString('hex').toUpperCase()}`;
          await client.query(
            `INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json)
             VALUES ($1, 'partner_wallet', $2, $3, $4, 'pending', $5::jsonb)`,
            [orderId, providerRef, price.toString(), config.currency, JSON.stringify({ method: 'partner_wallet', listed_minor: listed.toString(), cut_bps: resolvedCutBps, cost_minor: cost.toString(), cost_points: costPoints.toString(), price_points: pricePoints.toString(), cost_source: costSource })],
          );
          return { status: 201, body: { data: { id: saleId, order_id: orderId, external_reference: request.body.external_reference, price_minor: price.toString(), cost_minor: cost.toString(), listed_minor: listed.toString(), cut_bps: cut, price_points: pricePoints.toString(), cost_points: costPoints.toString(), cost_source: costSource, wallet_balance_points: debit.balance.toString(), currency: config.currency, status: 'completed' } }, saleId, providerRef, price };
      });
      const payload = phase1;
      if (payload.saleId && payload.providerRef) {
        // Phase 2: settle through the standard pipeline (entitlement,
        // site creation, webhooks). If settlement fails, refund the
        // wallet and cancel the order — the partner never pays for an
        // unfulfilled sale.
        const rawBody = JSON.stringify({ wallet_sale: payload.saleId });
        let outcome: string | null = null;
        try {
          outcome = await processPaymentEvent(db, 'partner_wallet', rawBody, {
            providerEventId: `wallet_sale_${payload.saleId}`,
            providerRef: payload.providerRef,
            amountMinor: payload.price.toString(),
            currency: config.currency,
            status: 'settled',
            occurredAt: new Date(),
          });
        } catch {
          outcome = null;
        }
        if (outcome !== 'processed') {
          await tx(db, async (client) => {
            const sale = await client.query<{ cost_points: string; order_id: string }>('SELECT cost_points::text, order_id FROM partner_wallet_sales WHERE id = $1 FOR UPDATE', [payload.saleId]);
            if (sale.rows[0]) {
              await creditWallet(client, partnerId, BigInt(sale.rows[0].cost_points), 'sale_refund', 'partner_wallet_sale', payload.saleId, 'settlement_failed');
              await client.query("UPDATE partner_wallet_sales SET status = 'refunded' WHERE id = $1", [payload.saleId]);
              await client.query("UPDATE orders SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1 AND status = 'awaiting_payment'", [sale.rows[0].order_id]);
            }
          });
          throw errors.conflict('partner.sale_failed');
        }
        // Settlement delivered: only now does the sale become 'completed'
        // (audit payments M3). If THIS write crashes, the row stays
        // 'pending' and the worker sweep would refund a delivered sale —
        // so it runs immediately, in its own transaction, before replying.
        await tx(db, async (client) => {
          await client.query("UPDATE partner_wallet_sales SET status = 'completed' WHERE id = $1 AND status = 'pending'", [payload.saleId]);
        });
      }
      return reply.status(payload.status).send(payload.body);
    },
  );
}

export { SCOPES };
