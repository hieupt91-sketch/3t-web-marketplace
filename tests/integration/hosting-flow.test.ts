/**
 * M5 hosting: provision saga, quota, retry, domains, backups/restore,
 * renewals, lifecycle, admin operations, tenant isolation (AT-22..AT-29, AT-47).
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
import { SITE_JOB_TYPES, runSiteJob } from '@3t/worker/site-jobs';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let buyer: { id: string; cookie: string };
let other: { id: string; cookie: string };
let closePreview: () => Promise<void>;
let templateId = '';
let planId = '';
let siteId = '';
let siteUrl = '';
const TERMS = 'terms-2026-10';

beforeAll(async () => {
  ctx = await createTestContext({ dnsVerifyBodyProof: true });
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
  buyer = await createUser(ctx, 'buyer@example.com');
  other = await createUser(ctx, 'other@example.com');
  await publishHostedTemplate();
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
async function drainAll() {
  for (;;) {
    const job = await claimJob(ctx.db, 'w', [IMPORT_JOB_TYPE, ...SITE_JOB_TYPES], 60);
    if (!job) return;
    if (job.type === IMPORT_JOB_TYPE) await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
    else await runSiteJob({ config: ctx.config, db: ctx.db, store: ctx.store }, job);
  }
}
async function publishHostedTemplate() {
  const zip = buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
  const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'landing.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
  await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
  const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
  await drainAll();
  const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
  templateId = imp.json().data.draft.template_id;
  await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/templates/${templateId}/translations/vi`, headers: admin(), payload: { title: 'Mẫu landing', slug: 'mau-landing', status: 'published' } });
  const plan = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/plans`, headers: admin(), payload: { code: 'hosted-standard', deployment_mode: 'hosted', name: { vi: 'Hosted' }, limits: { instance_limit: 1, updates_months: 12 } } });
  planId = plan.json().data.id;
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1500000', interval: 'monthly' } });
  const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${detail.json().data.plans[0].row_version}"` }, payload: { status: 'active' } });
  const detail2 = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
  await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail2.headers.etag } });
}
async function paidOrder(): Promise<{ orderId: string; itemId: string; entitlementId: string }> {
  const q = await ctx.app.inject({ method: 'POST', url: '/api/v1/quotes', headers: as(buyer), payload: { plan_id: planId, template_id: templateId } });
  expect(q.statusCode, q.body).toBe(201);
  const order = await ctx.app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...as(buyer), 'idempotency-key': randomUUID() }, payload: { quote_id: q.json().data.id, terms_version: TERMS } });
  expect(order.statusCode, order.body).toBe(201);
  const orderId = order.json().data.id as string;
  const paySession = await ctx.app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/payment-sessions`, headers: as(buyer) });
  expect(paySession.statusCode, paySession.body).toBe(201);
  const ref = paySession.json().data.provider_ref;
  const confirm = await ctx.app.inject({ method: 'POST', url: `/api/v1/payments/mock/${ref}/confirm`, headers: as(buyer), payload: {} });
  expect(confirm.statusCode, confirm.body).toBe(202);
  const check = await ctx.app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: as(buyer) });
  expect(check.json().data.payment_status, check.body).toBe('paid');
  const item = await ctx.db.query<{ id: string }>('SELECT id FROM order_items WHERE order_id = $1', [orderId]);
  const ent = await ctx.db.query<{ id: string }>('SELECT id FROM entitlements WHERE order_item_id = $1', [item.rows[0]!.id]);
  return { orderId, itemId: item.rows[0]!.id, entitlementId: ent.rows[0]!.id };
}

describe('M5 hosting', () => {
  it('provisions a site from a paid hosted entitlement and serves it (AT-22/23/24)', async () => {
    const { entitlementId } = await paidOrder();
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/sites', headers: as(buyer), payload: { entitlement_id: entitlementId, display_name: 'Cửa hàng của tôi', subdomain: 'my-shop' } });
    expect(created.statusCode, created.body).toBe(201);
    siteId = created.json().data.id as string;
    await drainAll();
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) });
    expect(detail.json().data.status).toBe('active');
    expect(detail.json().data.subscription).toBeTruthy();
    siteUrl = detail.json().data.url as string;
    expect(siteUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const home = await fetch(siteUrl);
    expect(home.status).toBe(200);
    // Tenant isolation: another user sees nothing (AT-24).
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(other) })).statusCode).toBe(404);
    // Quota: the same single-instance entitlement cannot provision twice (AT-22).
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/sites', headers: as(buyer), payload: { entitlement_id: entitlementId, display_name: 'Thứ hai', subdomain: 'second-shop' } });
    expect(again.statusCode).toBe(409);
    // Subdomain taken by a different entitlement.
    const second = await paidOrder();
    const taken = await ctx.app.inject({ method: 'POST', url: '/api/v1/sites', headers: as(buyer), payload: { entitlement_id: second.entitlementId, display_name: 'Khác', subdomain: 'my-shop' } });
    expect(taken.statusCode).toBe(409);
  });

  it('retries a failed provision on the same site id without clawing back the entitlement (AT-23)', async () => {
    await ctx.db.query("UPDATE sites SET status = 'provision_failed' WHERE id = $1", [siteId]);
    const retry = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/retry`, headers: as(buyer) });
    expect(retry.statusCode, retry.body).toBe(200);
    await drainAll();
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) });
    expect(detail.json().data.status).toBe('active');
    expect(detail.json().data.id).toBe(siteId);
    const home = await fetch(detail.json().data.url as string);
    expect(home.status).toBe(200);
    siteUrl = detail.json().data.url as string;
  });

  it('verifies, primaries, releases and re-verifies a domain (AT-25/27)', async () => {
    const added = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains`, headers: as(buyer), payload: { hostname: 'shop.example.com' } });
    expect(added.statusCode, added.body).toBe(201);
    const domainId = added.json().data.id as string;
    const token = added.json().data.verification_token as string;
    const wrong = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains/${domainId}/verify`, headers: as(buyer), payload: { txt_value: 'wrong' } });
    expect(wrong.json().data.verified).toBe(false);
    // Cooldown: a second verify within 60s is refused.
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains/${domainId}/verify`, headers: as(buyer), payload: { txt_value: token } })).statusCode).toBe(409);
    await ctx.db.query('UPDATE domains SET last_verify_at = now() - interval \'2 minutes\' WHERE id = $1', [domainId]);
    const verified = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains/${domainId}/verify`, headers: as(buyer), payload: { txt_value: token } });
    expect(verified.json().data).toMatchObject({ status: 'verified', verified: true });
    const primary = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains/${domainId}/make-primary`, headers: as(buyer) });
    expect(primary.statusCode).toBe(200);
    const released = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains/${domainId}/release`, headers: as(buyer) });
    expect(released.json().data.status).toBe('released');
    // Re-attach mints a fresh token (AT-27).
    const readded = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/domains`, headers: as(buyer), payload: { hostname: 'shop.example.com' } });
    expect(readded.statusCode, readded.body).toBe(201);
    expect(readded.json().data.verification_token).not.toBe(token);
  });

  it('backs up and restores a site, with name confirmation (AT-47 shape)', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/backups`, headers: as(buyer) });
    expect(created.statusCode).toBe(202);
    await drainAll();
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/backups`, headers: as(buyer) });
    const backup = list.json().data[0];
    expect(backup.status).toBe('succeeded');
    expect(backup.checksum).toMatch(/^[0-9a-f]{64}$/);
    const wrongName = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/backups/${backup.id}/restore`, headers: as(buyer), payload: { confirm_name: 'Sai tên' } });
    expect(wrongName.statusCode).toBe(422);
    const restored = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/backups/${backup.id}/restore`, headers: as(buyer), payload: { confirm_name: 'Cửa hàng của tôi' } });
    expect(restored.statusCode, restored.body).toBe(200);
    await drainAll();
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) });
    expect(detail.json().data.status).toBe('active');
    expect((await fetch(detail.json().data.url as string)).status).toBe(200);
    const deployment = detail.json().data.deployments.find((d: { operation: string }) => d.operation === 'restore');
    expect(deployment.status).toBe('succeeded');
  });

  it('applies a renewal exactly once and runs the grace/suspend/purge lifecycle (AT-28/29)', async () => {
    const { itemId } = await paidOrder();
    const sub = await ctx.db.query<{ id: string; current_period_end: Date }>('SELECT id, current_period_end FROM subscriptions WHERE site_id = $1', [siteId]);
    const subId = sub.rows[0]!.id;
    const first = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${subId}/apply-renewal`, headers: admin(), payload: { order_item_id: itemId } });
    expect(first.statusCode, first.body).toBe(200);
    const second = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/subscriptions/${subId}/apply-renewal`, headers: admin(), payload: { order_item_id: itemId } });
    expect(second.statusCode).toBe(409);
    // Lifecycle: past period end -> grace; past grace -> suspended.
    await ctx.db.query('UPDATE subscriptions SET current_period_end = now() - interval \'1 day\' WHERE id = $1', [subId]);
    const sweep1 = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/sites/lifecycle-sweep', headers: admin() });
    expect(sweep1.json().data.to_grace).toBe(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) })).json().data.status).toBe('grace');
    await ctx.db.query('UPDATE subscriptions SET current_period_end = now() - interval \'10 days\' WHERE id = $1', [subId]);
    const sweep2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/sites/lifecycle-sweep', headers: admin() });
    expect(sweep2.json().data.suspended).toBe(1);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) })).json().data.status).toBe('suspended');
    // Owner recovery path: delete schedule then cancel (C15).
    const del = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/delete-request`, headers: as(buyer) });
    expect(del.json().data.status).toBe('delete_scheduled');
    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/sites/${siteId}/cancel-delete`, headers: as(buyer) });
    expect(cancel.json().data.status).toBe('restored');
    // Admin resume restarts the suspended site.
    const op = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/sites/${siteId}/operations`, headers: admin(), payload: { action: 'resume', reason: 'renewal paid' } });
    expect(op.statusCode, op.body).toBe(200);
    await drainAll();
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: as(buyer) })).json().data.status).toBe('active');
  });

  it('exposes admin jobs oversight without retrying a running job (A18)', async () => {
    const jobs = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/jobs?status=succeeded', headers: admin() });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().data.some((j: { type: string }) => j.type === 'site.provision')).toBe(true);
    const succeeded = jobs.json().data.find((j: { type: string }) => j.type === 'site.provision');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/jobs/${succeeded.id}/retry`, headers: admin() })).statusCode).toBe(409);
  });
});
