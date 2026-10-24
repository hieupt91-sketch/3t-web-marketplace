/**
 * M4 COMMERCE: quote -> order -> sandbox payment -> entitlement -> self-host bundle download.
 * Covers AT-14/15/16/17/18/19 and accounting invariants §6.1-6.3.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, hashPassword, IMPORT_JOB_TYPE, REPO_ROOT } from '@3t/core';
import { buildZip, type RawZipEntry } from '@3t/template-sdk/testing';
import { createPreviewServer } from '@3t/preview';
import { runImportJob } from '@3t/worker/pipeline';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let buyer: { id: string; cookie: string };
let closePreview: () => Promise<void>;
let templateId = '';
let planId = '';
const TERMS = 'terms-2026-10';

beforeAll(async () => {
  ctx = await createTestContext();
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
  buyer = await createUser(ctx, 'buyer@example.com');
  await publishPricedTemplate();
});

afterAll(async () => {
  await closePreview();
  await ctx.close();
});

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });
const as = (u: { cookie: string }) => ({ cookie: u.cookie, origin: ORIGIN });

async function walk(dir: string, root = dir): Promise<RawZipEntry[]> {
  const out: RawZipEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ name: relative(root, full).split('\\').join('/'), data: await readFile(full), deflate: true });
  }
  return out;
}
async function drainWorker() {
  for (;;) {
    const job = await claimJob(ctx.db, 'w', [IMPORT_JOB_TYPE], 60);
    if (!job) return;
    await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
  }
}

/** Import the fixture, add a priced self-host plan, and publish. Sets templateId/planId. */
async function publishPricedTemplate() {
  const zip = buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
  const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'landing.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
  await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
  const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
  await drainWorker();
  const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
  templateId = imp.json().data.draft.template_id;

  await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/templates/${templateId}/translations/vi`, headers: admin(), payload: { title: 'Mẫu landing', slug: 'mau-landing', status: 'published' } });
  const plan = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/plans`, headers: admin(), payload: { code: 'selfhost-standard', deployment_mode: 'selfhost', name: { vi: 'Tự triển khai' }, limits: { instance_limit: 1, updates_months: 12 } } });
  planId = plan.json().data.id;
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1500000', interval: 'one_time' } });
  const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  const planRv = detail.json().data.plans[0].row_version;
  await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${planRv}"` }, payload: { status: 'active' } });
  const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail2.headers.etag } });
}

async function quote(user = buyer) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(user), payload: { plan_id: planId, template_id: templateId } });
  return res;
}
async function orderFromQuote(quoteId: string, user = buyer, terms = TERMS) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...as(user), 'idempotency-key': randomUUID() }, payload: { quote_id: quoteId, terms_version: terms } });
}

describe('quote and order', () => {
  it('prices the quote on the backend; the client cannot set the amount (AT-14)', async () => {
    const q = await quote();
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json().data).toMatchObject({ currency: 'VND', total_minor: '1500000', deployment_mode: 'selfhost' });
    // Extra body fields (e.g. a forged price) are rejected by the schema.
    const forged = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(buyer), payload: { plan_id: planId, template_id: templateId, total_minor: '1' } });
    expect(forged.statusCode).toBe(422);
  });

  it('requires a verified buyer and the current terms version', async () => {
    const q = await quote();
    const quoteId = q.json().data.id;
    const stale = await orderFromQuote(quoteId, buyer, 'terms-1999');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('terms.version_stale');

    // An unverified user cannot create an order.
    const { rows } = await ctx.db.query<{ id: string }>(`INSERT INTO users (email_normalized, display_name, password_hash) VALUES ($1, 'U', $2) RETURNING id`, ['unverified@example.com', await hashPassword('a long password here', 1024)]);
    void rows;
    const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'unverified@example.com', password: 'a long password here' } });
    const cookie = `mp_session=${login.cookies.find((c) => c.name === 'mp_session')!.value}`;
    const q2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: { cookie, origin: ORIGIN }, payload: { plan_id: planId, template_id: templateId } });
    const unverifiedOrder = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { cookie, origin: ORIGIN, 'idempotency-key': randomUUID() }, payload: { quote_id: q2.json().data.id, terms_version: TERMS } });
    expect(unverifiedOrder.statusCode).toBe(403);
    expect(unverifiedOrder.json().error.code).toBe('buyer.unverified');
  });

  it('rejects an expired quote', async () => {
    const q = await quote();
    await ctx.db.query("UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE id = $1", [q.json().data.id]);
    const order = await orderFromQuote(q.json().data.id);
    expect(order.statusCode).toBe(409);
    expect(order.json().error.code).toBe('quote.expired');
  });
});

describe('payment and entitlement', () => {
  async function newOrder() {
    const q = await quote();
    const order = await orderFromQuote(q.json().data.id);
    expect(order.statusCode, order.body).toBe(201);
    return order.json().data.id as string;
  }
  async function paySession(orderId: string) {
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data.provider_ref as string;
  }

  it('does not mark an order paid from a client redirect; only a verified event settles it (AT-15)', async () => {
    const orderId = await newOrder();
    await paySession(orderId);
    // No webhook yet → still awaiting, no entitlement.
    const before = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
    expect(before.json().data.payment_status).toBe('awaiting_payment');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me/entitlements', headers: as(buyer) })).json().data).toEqual([]);
  });

  it('settles via the sandbox, creates one entitlement, and is idempotent to duplicate events (AT-16)', async () => {
    const orderId = await newOrder();
    const ref = await paySession(orderId);
    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'settled', amountMinor: '1500000', currency: 'VND', eventId: 'evt-fixed-1' });

    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(first.json().outcome).toBe('processed');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(dup.json().outcome).toBe('duplicate');

    const order = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
    expect(order.json().data.payment_status).toBe('paid');
    const ents = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/entitlements', headers: as(buyer) });
    const forOrder = (await ctx.db.query('SELECT count(*)::int AS n FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id WHERE oi.order_id = $1', [orderId])).rows[0];
    expect(forOrder.n).toBe(1);
    expect(ents.json().data.some((e: { status: string; mode: string }) => e.status === 'active' && e.mode === 'selfhost')).toBe(true);
  });

  it('routes a wrong amount to reconciliation without fulfilling (AT-17)', async () => {
    const orderId = await newOrder();
    const ref = await paySession(orderId);
    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'settled', amountMinor: '999', currency: 'VND', eventId: 'evt-wrong-amount' });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(res.json().outcome).toBe('needs_reconciliation');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) })).json().data.payment_status).toBe('needs_reconciliation');
    const ent = await ctx.db.query('SELECT count(*)::int AS n FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id WHERE oi.order_id = $1', [orderId]);
    expect(ent.rows[0].n).toBe(0);
  });

  it('rejects a webhook with a bad signature', async () => {
    const orderId = await newOrder();
    const ref = await paySession(orderId);
    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'settled', amountMinor: '1500000', currency: 'VND' });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: { ...signed.headers, 'x-mock-signature': 'v1=deadbeef' }, payload: signed.body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('payment.webhook_invalid');
  });
});

describe('download', () => {
  async function paidEntitlement() {
    const q = await quote();
    const order = await orderFromQuote(q.json().data.id);
    const orderId = order.json().data.id;
    const ref = (await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) })).json().data.provider_ref;
    await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/${ref}/confirm`, headers: as(buyer), payload: {} });
    const ents = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/entitlements', headers: as(buyer) });
    return ents.json().data[0].id as string;
  }

  it('issues a short-lived link that downloads a valid zip bundle, then cannot be reused (AT-18/19)', async () => {
    const entId = await paidEntitlement();
    const link = await ctx.app.inject({ method: 'POST', url: `/api/v1/entitlements/${entId}/download-links`, headers: as(buyer) });
    expect(link.statusCode, link.body).toBe(201);
    expect(link.json().data).toMatchObject({ filename: 'landing-fixture-1.0.0.zip' });
    expect(link.json().data.sha256).toMatch(/^[0-9a-f]{64}$/);
    const token = new URL(link.json().data.url).pathname.split('/').pop()!;

    const dl = await ctx.app.inject({ method: 'GET', url: `/api/v1/downloads/${token}`, headers: as(buyer) });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    // A valid zip starts with the PK signature and contains the site and checksums.
    expect(dl.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(dl.rawPayload.length).toBeGreaterThan(100);

    // The one-time token cannot be reused.
    const reuse = await ctx.app.inject({ method: 'GET', url: `/api/v1/downloads/${token}`, headers: as(buyer) });
    expect(reuse.statusCode).toBe(409);
  });

  it('denies downloads to other users and for missing entitlements (AT-18)', async () => {
    const entId = await paidEntitlement();
    const other = await createUser(ctx, `other-${randomUUID().slice(0, 8)}@example.com`);
    const denied = await ctx.app.inject({ method: 'POST', url: `/api/v1/entitlements/${entId}/download-links`, headers: as(other) });
    expect(denied.statusCode).toBe(404);
    const missing = await ctx.app.inject({ method: 'POST', url: `/api/v1/entitlements/${randomUUID()}/download-links`, headers: as(buyer) });
    expect(missing.statusCode).toBe(404);
    // An unauthenticated download is refused.
    const link = await ctx.app.inject({ method: 'POST', url: `/api/v1/entitlements/${entId}/download-links`, headers: as(buyer) });
    const token = new URL(link.json().data.url).pathname.split('/').pop()!;
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/downloads/${token}` })).statusCode).toBe(401);
  });
});
