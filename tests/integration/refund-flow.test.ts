/**
 * M4 close: refunds + reconciliation (AT-56, A12, B05).
 * Covers: request validation, approve/reject, failed-then-confirmed applying exactly once,
 * partial then full refund revoking entitlements, duplicate refund events, reconciliation
 * listing + resolve-to-paid, and permission enforcement.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, IMPORT_JOB_TYPE, REPO_ROOT } from '@3t/core';
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
  await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${detail.json().data.plans[0].row_version}"` }, payload: { status: 'active' } });
  const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail2.headers.etag } });
}

async function paidOrder(): Promise<string> {
  const q = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(buyer), payload: { plan_id: planId, template_id: templateId } });
  const order = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...as(buyer), 'idempotency-key': randomUUID() }, payload: { quote_id: q.json().data.id, terms_version: TERMS } });
  const orderId = order.json().data.id as string;
  const ref = (await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) })).json().data.provider_ref;
  await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/${ref}/confirm`, headers: as(buyer), payload: {} });
  const check = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
  expect(check.json().data.payment_status).toBe('paid');
  return orderId;
}

async function requestRefund(orderId: string, amount: string) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/refund-requests`, headers: as(buyer), payload: { amount_minor: amount, reason: 'test' } });
}

async function orderStatus(orderId: string) {
  return (await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) })).json().data.payment_status as string;
}

async function approveRefund(refundId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/refunds/${refundId}/approve`, headers: admin(), payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.provider_ref as string;
}

describe('refund requests', () => {
  it('rejects refunds on unpaid orders and amounts above the remainder', async () => {
    const q = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(buyer), payload: { plan_id: planId, template_id: templateId } });
    const order = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...as(buyer), 'idempotency-key': randomUUID() }, payload: { quote_id: q.json().data.id, terms_version: TERMS } });
    const unpaid = await requestRefund(order.json().data.id, '1000');
    expect(unpaid.statusCode).toBe(409);
    expect(unpaid.json().error.code).toBe('refund.order_not_refundable');

    const paid = await paidOrder();
    const tooBig = await requestRefund(paid, '1500001');
    expect(tooBig.statusCode).toBe(409);
    expect(tooBig.json().error.code).toBe('refund.amount_exceeds_remaining');
  });

  it('rejects admin refund actions for buyers (AT-31)', async () => {
    const paid = await paidOrder();
    const req = await requestRefund(paid, '100000');
    expect(req.statusCode).toBe(201);
    const denied = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/refunds/${req.json().data.id}/approve`, headers: as(buyer), payload: {} });
    expect(denied.statusCode).toBe(403);
  });

  it('rejects then re-approves: rejected requests free the remainder', async () => {
    const paid = await paidOrder();
    const req = await requestRefund(paid, '500000');
    const reject = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/refunds/${req.json().data.id}/reject`, headers: admin(), payload: { reason: 'not eligible' } });
    expect(reject.statusCode).toBe(200);
    expect(await orderStatus(paid)).toBe('paid');
    const again = await requestRefund(paid, '1500000');
    expect(again.statusCode).toBe(201);
  });
});

describe('refund settlement (AT-56)', () => {
  it('failed then confirmed applies exactly once; partial then full revokes the entitlement', async () => {
    const paid = await paidOrder();
    // Partial refund: fail first, then confirm.
    const req1 = await requestRefund(paid, '500000');
    const ref1 = await approveRefund(req1.json().data.id);
    expect(await orderStatus(paid)).toBe('refund_pending');
    const fail = await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/refunds/${ref1}/fail`, headers: as(buyer), payload: {} });
    expect(fail.statusCode).toBe(202);
    expect(await orderStatus(paid)).toBe('paid'); // failed refund frees the order again
    const req2 = await requestRefund(paid, '500000');
    const ref2 = await approveRefund(req2.json().data.id);
    const confirm = await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/refunds/${ref2}/confirm`, headers: as(buyer), payload: {} });
    expect(confirm.statusCode).toBe(202);
    expect(await orderStatus(paid)).toBe('partially_refunded');
    const ents = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/entitlements', headers: as(buyer) });
    expect(ents.json().data.some((e: { status: string }) => e.status === 'active')).toBe(true);

    // Full remainder: duplicate provider events must not double-apply.
    const req3 = await requestRefund(paid, '1000000');
    const ref3 = await approveRefund(req3.json().data.id);
    const signed = ctx.payment.signRefundEvent({ refundRef: ref3, status: 'confirmed', amountMinor: '1000000', currency: 'VND', eventId: 'evt-refund-fixed-1' });
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/refund-webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(first.json().outcome).toBe('processed');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/refund-webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(dup.json().outcome).toBe('duplicate');
    expect(await orderStatus(paid)).toBe('refunded');
    const revoked = await ctx.db.query('SELECT count(*)::int AS n FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id WHERE oi.order_id = $1 AND e.status = $2', [paid, 'revoked']);
    expect(revoked.rows[0].n).toBe(1);
    // A revoked entitlement cannot issue a new download link.
    const entRow = await ctx.db.query('SELECT e.id FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id WHERE oi.order_id = $1', [paid]);
    const link = await ctx.app.inject({ method: 'POST', url: `/api/v1/entitlements/${entRow.rows[0].id}/download-links`, headers: as(buyer) });
    expect(link.statusCode).toBe(403);
  });
});

describe('reconciliation (A12)', () => {
  it('lists mismatched orders, resolves to paid with fulfilment, and blocks re-resolve', async () => {
    const q = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(buyer), payload: { plan_id: planId, template_id: templateId } });
    const order = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...as(buyer), 'idempotency-key': randomUUID() }, payload: { quote_id: q.json().data.id, terms_version: TERMS } });
    const orderId = order.json().data.id as string;
    const ref = (await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) })).json().data.provider_ref;
    const signed = ctx.payment.signEvent({ providerRef: ref, status: 'settled', amountMinor: '999', currency: 'VND', eventId: 'evt-recon-1' });
    await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/mock', headers: signed.headers, payload: signed.body });
    expect(await orderStatus(orderId)).toBe('needs_reconciliation');

    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/reconciliation', headers: as(buyer) });
    expect(denied.statusCode).toBe(403);
    const queue = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/reconciliation', headers: admin() });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.orders.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const resolve = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/reconciliation/orders/${orderId}/resolve`, headers: admin(), payload: { resolution: 'paid', reason: 'bank statement confirms full amount' } });
    expect(resolve.statusCode, resolve.body).toBe(200);
    expect(await orderStatus(orderId)).toBe('paid');
    const ent = await ctx.db.query('SELECT count(*)::int AS n FROM entitlements e JOIN order_items oi ON oi.id = e.order_item_id WHERE oi.order_id = $1', [orderId]);
    expect(ent.rows[0].n).toBe(1);

    const again = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/reconciliation/orders/${orderId}/resolve`, headers: admin(), payload: { resolution: 'cancelled', reason: 'already resolved' } });
    expect(again.statusCode).toBe(409);
  });
});
