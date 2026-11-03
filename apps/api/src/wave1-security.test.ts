import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken, randomToken, tx } from '@3t/core';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';
import { expireStaleOrder, recomputeOrderRefundStatus } from './routes/commerce.ts';

/**
 * Wave-1 audit fixes (2026-11-02): partner double entitlement (payments
 * H1), partner order expiry (payments H2), full-refund teardown
 * (payments H3), demo-session ownership (UI-HIGH-01 / code M-04),
 * step-up for money actions (code H-02 + M-03) and the GitHub import
 * tarball hardening (code H-03).
 */
let ctx: TestContext;
let ownerCookie: string;
let ownerId: string;
const PASSWORD = 'correct horse battery staple';
const TERMS = 'terms-2026-10';
const HUB_KEY = 'wave1-hub-key';

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });
const stepUp = async (cookie: string) => {
  const res = await post('/api/v1/auth/step-up', { password: PASSWORD }, cookie);
  expect(res.statusCode, res.body).toBe(200);
};

let templateId: string;
let versionId: string;
let planId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'wave1-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  ownerId = owner.id;
  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('wave1-tpl', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/wave1', $1, 4, 'application/zip', 'runtime_bundle', 'permanent') RETURNING id`,
    ['f'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'f'.repeat(64), artifact.rows[0]!.id],
  );
  versionId = version.rows[0]!.id;
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [templateId, versionId]);
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'hosted', 'hosted', '{"vi":"Gói hosted"}'::jsonb, '{"instance_limit":1,"updates_months":12}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  planId = plan.rows[0]!.id;

  // Bank settings with a hub key, configured by the (stepped-up) owner.
  await stepUp(ownerCookie);
  const bank = await post('/api/v1/admin/settings/payment', {
    enabled: true, bank_name: 'Vietcombank', bank_bin: '970436', account_number: '0123456789',
    account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
  }, ownerCookie);
  expect(bank.statusCode, bank.body).toBe(200);
});
afterAll(async () => ctx.close());

/* --------------------- partner checkout: H1 + H2 --------------------- */

describe('partner checkout (payments H1 + H2)', () => {
  let partnerCookie: string;
  let partnerId: string;

  async function partnerOrder(externalRef: string): Promise<string> {
    const claimToken = randomToken();
    const snapshot = {
      template_id: templateId, version_id: versionId, plan_id: planId,
      plan_name: { vi: 'Gói hosted' }, deployment_mode: 'hosted',
      lines: [
        { label: 'setup', interval: 'one_time', amount_minor: '100000' },
        { label: 'first_period', interval: 'monthly', amount_minor: '499000' },
      ],
      limits: { instance_limit: 1, updates_months: 12 }, storage_gb: 5,
    };
    const quote = await ctx.db.query<{ id: string }>(
      `INSERT INTO quotes (partner_id, currency, subtotal_minor, discount_minor, tax_minor, total_minor, snapshot_json, expires_at)
       VALUES ($1, 'VND', 599000, 0, 0, 599000, $2::jsonb, now() + interval '15 minutes') RETURNING id`,
      [partnerId, JSON.stringify(snapshot)],
    );
    const session = await ctx.db.query<{ id: string }>(
      `INSERT INTO checkout_sessions (partner_id, quote_id, external_reference, claim_token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'awaiting_buyer', now() + interval '1 hour') RETURNING id`,
      [partnerId, quote.rows[0]!.id, externalRef, hashToken(claimToken).toString('hex')],
    );
    const sessionId = session.rows[0]!.id;
    const claim = await post(`/api/v1/partner/checkout-sessions/${sessionId}/claim`, { claim_token: claimToken }, partnerCookie);
    expect(claim.statusCode, claim.body).toBe(200);
    const order = await post(`/api/v1/partner/checkout-sessions/${sessionId}/order`, {}, partnerCookie);
    expect(order.statusCode, order.body).toBe(201);
    return order.json().data.order_id as string;
  }

  beforeAll(async () => {
    const partner = await createUser(ctx, 'wave1-partner@example.com');
    partnerCookie = partner.cookie;
    const account = await ctx.db.query<{ id: string }>(
      "INSERT INTO partner_accounts (user_id, code, display_name, status) VALUES ($1, 'WAVE1', 'Wave1 Partner', 'active') RETURNING id",
      [partner.id],
    );
    partnerId = account.rows[0]!.id;
  });

  it('creates ONE order item and a 15-minute payment window', async () => {
    const orderId = await partnerOrder('w1-order-1');
    const items = await ctx.db.query<{ unit_price_minor: string }>('SELECT unit_price_minor::text FROM order_items WHERE order_id = $1', [orderId]);
    expect(items.rows.length).toBe(1);
    expect(items.rows[0]!.unit_price_minor).toBe('599000');
    const order = await ctx.db.query<{ mins: string }>(
      'SELECT extract(epoch FROM (payment_window_expires_at - created_at)) / 60 AS mins FROM orders WHERE id = $1',
      [orderId],
    );
    expect(Number(order.rows[0]!.mins)).toBeGreaterThan(13);
    expect(Number(order.rows[0]!.mins)).toBeLessThan(17);
  });

  it('a settled partner checkout grants exactly ONE entitlement (H1)', async () => {
    const orderId = await partnerOrder('w1-order-2');
    const session = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, partnerCookie);
    expect(session.statusCode, session.body).toBe(201);
    const code = session.json().data.instructions.content_code as string;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 91001, gateway: 'Vietcombank', code, content: `${code} thanh toan`, transferType: 'in', transferAmount: 599000, referenceCode: 'FT91001' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('processed');
    const ents = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM entitlements WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)',
      [orderId],
    );
    expect(Number(ents.rows[0]!.n)).toBe(1);
  });

  it('partner orders expire like normal orders and late money reconciles (H2)', async () => {
    const orderId = await partnerOrder('w1-order-3');
    const session = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, partnerCookie);
    expect(session.statusCode, session.body).toBe(201);
    const code = session.json().data.instructions.content_code as string;
    await ctx.db.query("UPDATE orders SET payment_window_expires_at = now() - interval '1 minute' WHERE id = $1", [orderId]);
    const expired = await tx(ctx.db, (client) => expireStaleOrder(client, orderId, 'wave1-test'));
    expect(expired).toBe(true);
    const after = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(after.rows[0]!.status).toBe('expired');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/payments/webhooks/bank_transfer',
      headers: { authorization: `Apikey ${HUB_KEY}` },
      payload: { id: 91002, gateway: 'Vietcombank', code, content: `${code} thanh toan tre`, transferType: 'in', transferAmount: 599000, referenceCode: 'FT91002' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('needs_reconciliation');
    const final = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(final.rows[0]!.status).toBe('needs_reconciliation');
    const events = await ctx.db.query<{ processing_status: string }>(
      "SELECT processing_status FROM payment_events WHERE provider = 'bank_transfer' AND provider_event_id = '91002'",
    );
    expect(events.rows[0]!.processing_status).toBe('needs_reconciliation');
  });
});

/* ----------------------- full refund teardown: H3 ----------------------- */

describe('full refund teardown (payments H3)', () => {
  let buyerCookie: string;
  let buyerId: string;
  let nextVersionId: string;

  async function paidSite(seq: string, total: number): Promise<{ orderId: string; siteId: string; entitlementId: string }> {
    const quote = await ctx.db.query<{ id: string }>(
      `INSERT INTO quotes (buyer_id, currency, subtotal_minor, discount_minor, tax_minor, total_minor, snapshot_json, expires_at)
       VALUES ($1, 'VND', $2, 0, 0, $2, '{}'::jsonb, now() + interval '15 minutes') RETURNING id`,
      [buyerId, total],
    );
    const order = await ctx.db.query<{ id: string }>(
      `INSERT INTO orders (buyer_id, quote_id, currency, subtotal_minor, total_minor, terms_version, locale, status)
       VALUES ($1, $2, 'VND', $3, $3, $4, 'vi', 'paid') RETURNING id`,
      [buyerId, quote.rows[0]!.id, total, TERMS],
    );
    const item = await ctx.db.query<{ id: string }>(
      `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, snapshot_json, unit_price_minor, discount_minor, tax_minor)
       VALUES ($1, $2, $3, $4, 'hosted', '{}'::jsonb, $5, 0, 0) RETURNING id`,
      [order.rows[0]!.id, templateId, versionId, planId, total],
    );
    const ent = await ctx.db.query<{ id: string }>(
      "INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit) VALUES ($1, $2, $3, $4, 'hosted', 'active', 1) RETURNING id",
      [item.rows[0]!.id, buyerId, templateId, versionId],
    );
    const site = await ctx.db.query<{ id: string }>(
      "INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, default_locale, status) VALUES ($1, $2, $3, $4, $5, 'vi', 'active') RETURNING id",
      [buyerId, ent.rows[0]!.id, versionId, `Refund ${seq}`, `refund-${seq}`],
    );
    return { orderId: order.rows[0]!.id, siteId: site.rows[0]!.id, entitlementId: ent.rows[0]!.id };
  }

  async function addRefund(orderId: string, amount: number) {
    await ctx.db.query(
      "INSERT INTO refunds (order_id, buyer_id, amount_minor, currency, status) VALUES ($1, $2, $3, 'VND', 'confirmed')",
      [orderId, buyerId, amount],
    );
  }

  beforeAll(async () => {
    const buyer = await createUser(ctx, 'wave1-refund@example.com');
    buyerCookie = buyer.cookie;
    buyerId = buyer.id;
    const v = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       SELECT $1, '1.0.1', 1, '{}'::jsonb, 'node-http', $2, artifact_id, artifact_id, 'published' FROM template_versions WHERE id = $3 RETURNING id`,
      [templateId, 'f'.repeat(64), versionId],
    );
    nextVersionId = v.rows[0]!.id;
  });

  it('a full refund revokes the entitlement AND suspends the site', async () => {
    const { orderId, siteId, entitlementId } = await paidSite('full', 499000);
    await addRefund(orderId, 499000);
    await tx(ctx.db, (client) => recomputeOrderRefundStatus(client, orderId));
    const order = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0]!.status).toBe('refunded');
    const ent = await ctx.db.query<{ status: string }>('SELECT status FROM entitlements WHERE id = $1', [entitlementId]);
    expect(ent.rows[0]!.status).toBe('revoked');
    const site = await ctx.db.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [siteId]);
    expect(site.rows[0]!.status).toBe('suspended');
    // The suspended site cannot be updated (router 403s it publicly too).
    const upd = await post(`/api/v1/sites/${siteId}/update`, { version_id: nextVersionId }, buyerCookie);
    expect(upd.statusCode).toBe(409);
  });

  it('even an active-status site cannot update on a revoked entitlement', async () => {
    const { orderId, siteId } = await paidSite('gate', 499000);
    await addRefund(orderId, 499000);
    await tx(ctx.db, (client) => recomputeOrderRefundStatus(client, orderId));
    // Simulate an operator manually un-suspending the site: the update
    // gate must still refuse because the entitlement is not active.
    await ctx.db.query("UPDATE sites SET status = 'active' WHERE id = $1", [siteId]);
    const upd = await post(`/api/v1/sites/${siteId}/update`, { version_id: nextVersionId }, buyerCookie);
    expect(upd.statusCode, upd.body).toBe(409);
    expect(upd.json().error.code).toBe('site.update_window_expired');
  });

  it('a partial refund leaves the site and entitlement untouched', async () => {
    const { orderId, siteId, entitlementId } = await paidSite('part', 499000);
    await addRefund(orderId, 100000);
    await tx(ctx.db, (client) => recomputeOrderRefundStatus(client, orderId));
    const order = await ctx.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0]!.status).toBe('partially_refunded');
    const site = await ctx.db.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [siteId]);
    expect(site.rows[0]!.status).toBe('active');
    const ent = await ctx.db.query<{ status: string }>('SELECT status FROM entitlements WHERE id = $1', [entitlementId]);
    expect(ent.rows[0]!.status).toBe('active');
  });
});

/* ---------------- demo session ownership: UI-HIGH-01 / M-04 ---------------- */

describe('demo session ownership (UI-HIGH-01 / M-04)', () => {
  let staticVersionId: string;
  let readyVersionId: string;
  let draftVersionId: string;

  async function createDemo(version: string, cookie?: string) {
    return ctx.app.inject({
      method: 'POST', url: '/api/v1/demo-sessions',
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      payload: { version_id: version },
    });
  }

  function ownerTokenOf(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const text = Array.isArray(raw) ? raw.join(';') : String(raw ?? '');
    const match = text.match(/mp_demo_owner=([^;]+)/);
    expect(match, text).toBeTruthy();
    return `mp_demo_owner=${match![1]}`;
  }

  beforeAll(async () => {
    const artifact = await ctx.db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
       VALUES ('test/wave1-demo', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
      ['d'.repeat(64)],
    );
    const artifactId = artifact.rows[0]!.id;
    const tpl = await ctx.db.query<{ id: string }>(
      "INSERT INTO templates (slug, owner_id, status) VALUES ('wave1-demo-tpl', $1, 'published') RETURNING id",
      [ownerId],
    );
    const v = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
      [tpl.rows[0]!.id, 'd'.repeat(64), artifactId],
    );
    staticVersionId = v.rows[0]!.id;
    const imp = await ctx.db.query<{ id: string }>(
      "INSERT INTO imports (actor_id, source_kind, source_artifact_id, digest, name_hint, repo_id, commit_sha, status) VALUES ($1, 'github', $2, $3, 'wave1 demo', 'acme/widgets', $4, 'ready') RETURNING id",
      [ownerId, artifactId, 'd'.repeat(64), 'a'.repeat(40)],
    );
    await ctx.db.query(
      "INSERT INTO previews (import_id, version_id, artifact_id, entry, host_label, status) VALUES ($1, $2, $3, 'index.html', 'demow1preview000000001', 'active')",
      [imp.rows[0]!.id, staticVersionId, artifactId],
    );
    const ready = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.1', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'ready') RETURNING id`,
      [tpl.rows[0]!.id, 'd'.repeat(64), artifactId],
    );
    readyVersionId = ready.rows[0]!.id;
    const draftTpl = await ctx.db.query<{ id: string }>(
      "INSERT INTO templates (slug, owner_id, status) VALUES ('wave1-demo-draft', $1, 'draft') RETURNING id",
      [ownerId],
    );
    const dv = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
      [draftTpl.rows[0]!.id, 'd'.repeat(64), artifactId],
    );
    draftVersionId = dv.rows[0]!.id;
  });

  it('binds lifecycle actions to the creating browser', async () => {
    const created = await createDemo(staticVersionId);
    expect(created.statusCode, created.body).toBe(201);
    const sessionId = created.json().data.id as string;
    const owner = ownerTokenOf(created as never);
    const stranger = 'mp_demo_owner=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

    expect((await post(`/api/v1/demo-sessions/${sessionId}/reset`, {}, '')).statusCode).toBe(404);
    expect((await post(`/api/v1/demo-sessions/${sessionId}/reset`, {}, stranger)).statusCode).toBe(404);
    expect((await post(`/api/v1/demo-sessions/${sessionId}/cancel`, {}, stranger)).statusCode).toBe(404);
    expect((await post(`/api/v1/demo-sessions/${sessionId}/admin-launch`, {}, stranger)).statusCode).toBe(404);

    const reset = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${sessionId}/reset`, headers: { origin: ORIGIN, cookie: owner } });
    expect(reset.statusCode, reset.body).toBe(200);
    // Per-session cooldown: an immediate second reset is throttled.
    const again = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${sessionId}/reset`, headers: { origin: ORIGIN, cookie: owner } });
    expect(again.statusCode).toBe(429);

    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${sessionId}/cancel`, headers: { origin: ORIGIN, cookie: owner } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const row = await ctx.db.query<{ status: string }>('SELECT status FROM demo_sessions WHERE id = $1', [sessionId]);
    expect(row.rows[0]!.status).toBe('cancelled');
  });

  it('only published versions of published templates spawn demos', async () => {
    expect((await createDemo(readyVersionId)).statusCode).toBe(404);
    expect((await createDemo(draftVersionId)).statusCode).toBe(404);
  });
});

/* --------------------- step-up for money actions: H-02 + M-03 --------------------- */

describe('step-up for admin money actions (code H-02 + M-03)', () => {
  it('bank settings reject without step-up, accept with it, and audit both', async () => {
    const fresh = await createUser(ctx, 'wave1-stepup@example.com', 'platform_owner');
    const denied = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', bank_bin: '970436', account_number: '0123456789', account_holder: 'WEBMAKET TEST',
    }, fresh.cookie);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain('auth.step_up_required');

    const bad = await post('/api/v1/auth/step-up', { password: 'wrong password' }, fresh.cookie);
    expect(bad.statusCode).toBe(401);
    const failures = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'auth.step_up_failed' AND actor_id = $1",
      [fresh.id],
    );
    expect(Number(failures.rows[0]!.n)).toBeGreaterThanOrEqual(1);

    await stepUp(fresh.cookie);
    const ok = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', bank_bin: '970436', account_number: '0123456789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
    }, fresh.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    const audits = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'settings.payment_updated' AND actor_id = $1",
      [fresh.id],
    );
    expect(Number(audits.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('manual payment confirmation requires step-up', async () => {
    const buyer = await createUser(ctx, 'wave1-manual@example.com');
    const quote = await ctx.db.query<{ id: string }>(
      `INSERT INTO quotes (buyer_id, currency, subtotal_minor, discount_minor, tax_minor, total_minor, snapshot_json, expires_at)
       VALUES ($1, 'VND', 499000, 0, 0, 499000, '{}'::jsonb, now() + interval '15 minutes') RETURNING id`,
      [buyer.id],
    );
    const order = await ctx.db.query<{ id: string }>(
      `INSERT INTO orders (buyer_id, quote_id, currency, subtotal_minor, total_minor, terms_version, locale, status)
       VALUES ($1, $2, 'VND', 499000, 499000, $3, 'vi', 'awaiting_payment') RETURNING id`,
      [buyer.id, quote.rows[0]!.id, TERMS],
    );
    await ctx.db.query(
      `INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, snapshot_json, unit_price_minor, discount_minor, tax_minor)
       VALUES ($1, $2, $3, $4, 'hosted', '{}'::jsonb, 499000, 0, 0)`,
      [order.rows[0]!.id, templateId, versionId, planId],
    );
    const attempt = await ctx.db.query<{ id: string }>(
      `INSERT INTO payment_attempts (order_id, provider, provider_ref, amount_minor, currency, status, instructions_json)
       VALUES ($1, 'bank_transfer', 'WMWAVE1TST', 499000, 'VND', 'pending', '{}'::jsonb) RETURNING id`,
      [order.rows[0]!.id],
    );
    const fresh = await createUser(ctx, 'wave1-confirm@example.com', 'platform_owner');
    const denied = await post(`/api/v1/admin/payments/attempts/${attempt.rows[0]!.id}/confirm`, {}, fresh.cookie);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).toContain('auth.step_up_required');
    await stepUp(fresh.cookie);
    const ok = await post(`/api/v1/admin/payments/attempts/${attempt.rows[0]!.id}/confirm`, {}, fresh.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.outcome).toBe('processed');
    const audits = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'payment.manual_confirmed' AND actor_id = $1",
      [fresh.id],
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);
  });

  it('the step-up endpoint itself is rate-limited (M-03)', async () => {
    const limited = await createUser(ctx, 'wave1-limited@example.com', 'platform_owner');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await post('/api/v1/auth/step-up', { password: 'wrong password' }, limited.cookie);
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

/* --------------------- GitHub import hardening: H-03 --------------------- */

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'latin1');
  h.write('0000000\0', 108, 8, 'latin1');
  h.write('0000000\0', 116, 8, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  h.write('00000000000\0', 136, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');
  h.write(type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}
function tarEntry(name: string, data: string, type = '0'): Buffer {
  const body = Buffer.from(data, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, type), padded]);
}
const tarballOf = (parts: Buffer[]) => gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
const SHA = 'a'.repeat(40);

describe('GitHub import tarball hardening (code H-03)', () => {
  let tarball: Buffer;
  let savedPolicy: unknown;

  beforeAll(async () => {
    const policy = await ctx.db.query<{ value_json: unknown }>("SELECT value_json FROM settings WHERE key = 'import.policy'");
    savedPolicy = policy.rows[0]!.value_json;
    tarball = tarballOf([tarEntry('acme-widgets-aaa/', '', '5'), tarEntry('acme-widgets-aaa/index.html', '<h1>ok</h1>')]);
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tarball/')) return new Response(new Uint8Array(tarball));
      if (url.includes('/commits/')) return Response.json({ sha: SHA });
      return Response.json({ default_branch: 'main' });
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await ctx.db.query("UPDATE settings SET value_json = $1::jsonb WHERE key = 'import.policy'", [JSON.stringify(savedPolicy)]);
  });

  const importRepo = () => post('/api/v1/admin/imports/github', { repo: 'acme/widgets', rights_confirmed: true }, ownerCookie, { 'idempotency-key': randomUUID() });

  it('imports a clean tarball', async () => {
    const res = await importRepo();
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().data.commit_sha).toBe(SHA);
  });

  it('rejects a tarball with a parent-escaping entry', async () => {
    tarball = tarballOf([tarEntry('acme-widgets-aaa/index.html', 'ok'), tarEntry('acme-widgets-aaa/../../evil.txt', 'pwned')]);
    const res = await importRepo();
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('github.tarball_unsafe');
  });

  it('rejects a tarball with a symlink entry', async () => {
    tarball = tarballOf([tarEntry('acme-widgets-aaa/index.html', 'ok'), tarEntry('acme-widgets-aaa/link', '/etc/passwd', '2')]);
    const res = await importRepo();
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('github.tarball_unsafe');
  });

  it('rejects a download over the import policy byte cap', async () => {
    // Incompressible payload: the gzipped tarball itself must exceed the
    // (test-shrunk) 512-byte download cap.
    const { randomBytes } = await import('node:crypto');
    tarball = tarballOf([tarEntry('acme-widgets-aaa/index.html', randomBytes(3000).toString('base64'))]);
    const shrunk = { ...(savedPolicy as Record<string, unknown>), max_upload_bytes: 512 };
    await ctx.db.query("UPDATE settings SET value_json = $1::jsonb WHERE key = 'import.policy'", [JSON.stringify(shrunk)]);
    try {
      const res = await importRepo();
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain('github.tarball_too_large');
    } finally {
      await ctx.db.query("UPDATE settings SET value_json = $1::jsonb WHERE key = 'import.policy'", [JSON.stringify(savedPolicy)]);
    }
  });
});
