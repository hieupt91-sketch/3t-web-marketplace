/**
 * M3 close: A07 versions screen, A26 support tickets, category + price filters.
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
let staff: { id: string; cookie: string };
let customer: { id: string; cookie: string };
let closePreview: () => Promise<void>;
let templateId = '';

beforeAll(async () => {
  ctx = await createTestContext();
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
  staff = await createUser(ctx, 'staff@example.com', 'support');
  customer = await createUser(ctx, 'customer@example.com');
});

afterAll(async () => {
  await closePreview();
  await ctx.close();
});

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });
const asStaff = () => ({ cookie: staff.cookie, origin: ORIGIN });
const asCustomer = () => ({ cookie: customer.cookie, origin: ORIGIN });

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

describe('A07 versions + catalog filters', () => {
  it('publishes a categorized, priced template and exposes versions and filters', async () => {
    const zip = buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
    const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'landing.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
    await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
    await drainWorker();
    const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
    expect(imp.json().data.status).toBe('ready');
    templateId = imp.json().data.draft.template_id as string;

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
    expect(detail.statusCode).toBe(200);
    const landingCat = await ctx.db.query<{ id: string }>("SELECT id FROM template_categories WHERE code = 'landing'");
    const patched = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/templates/${templateId}`, headers: { ...admin(), 'if-match': detail.headers.etag as string }, payload: { category_id: landingCat.rows[0]!.id } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/templates/${templateId}/translations/vi`, headers: admin(), payload: { title: 'Landing vi', summary: 'Summary vi', slug: 'landing-vi', status: 'published' } })).statusCode).toBe(200);
    const plan = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/plans`, headers: admin(), payload: { code: 'selfhost-standard', deployment_mode: 'selfhost', name: { vi: 'Tự triển khai', en: 'Self-host' }, limits: { instance_limit: 1, updates_months: 12 } } });
    expect(plan.statusCode, plan.body).toBe(201);
    const planId = plan.json().data.id as string;
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1500000', interval: 'one_time' } })).statusCode).toBe(201);
    const planDetail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
    const rowVersion = planDetail.json().data.plans.find((p: { id: string }) => p.id === planId).row_version as number;
    expect((await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${rowVersion}"` }, payload: { status: 'active' } })).statusCode).toBe(200);
    const fresh = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() });
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': fresh.headers.etag as string } })).statusCode).toBe(200);

    // A07: versions carry SHA, manifest, artifact, import, demo, published flag.
    const versions = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/versions`, headers: admin() });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().data).toHaveLength(1);
    const v = versions.json().data[0];
    expect(v.semver).toBe('1.0.0');
    expect(v.source_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(v.artifact_kind).toBe('static_site');
    expect(v.import_id).toBe(created.json().data.resource_id);
    expect(v.manifest_json.adapter).toBe('static-html');
    expect(v.is_published).toBe(true);
    expect(v.demo_url).toMatch(/^http:\/\/[a-z2-7]{32}\.preview\.localhost:4100\/$/);

    // Filters: parent category includes the child; price bounds use the starting price.
    const cats = await ctx.app.inject({ method: 'GET', url: '/api/v1/categories' });
    const catByCode = Object.fromEntries(cats.json().data.map((c: { id: string; code: string; parent_id: string | null }) => [c.code, c]));
    expect(catByCode.landing.parent_id).toBe(catByCode.website.id);
    const byParent = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&category=website' });
    expect(byParent.json().data.map((t: { slug: string }) => t.slug)).toContain('landing-vi');
    const byOther = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&category=store' });
    expect(byOther.json().data).toEqual([]);
    const tooCheap = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&max_price=1000000' });
    expect(tooCheap.json().data).toEqual([]);
    const inRange = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&min_price=1000000&max_price=2000000' });
    expect(inRange.json().data.map((t: { slug: string }) => t.slug)).toContain('landing-vi');
    const tooExpensive = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&min_price=2000000' });
    expect(tooExpensive.json().data).toEqual([]);
  });
});

describe('A26 support tickets', () => {
  it('runs the customer → assign → reply → resolve loop in the customer locale, with SLA state', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/support/tickets', headers: asCustomer(), payload: { subject: 'Không tải được mẫu', body: 'Tôi mua mẫu nhưng link tải lỗi.', locale: 'vi' } });
    expect(created.statusCode, created.body).toBe(201);
    const ticketId = created.json().data.id as string;

    const otherAssign = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/support/${ticketId}/assign`, headers: asStaff(), payload: { staff_id: customer.id } });
    expect(otherAssign.statusCode).toBe(422);
    const assigned = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/support/${ticketId}/assign`, headers: asStaff(), payload: { staff_id: staff.id } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const reply = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/support/${ticketId}/reply`, headers: asStaff(), payload: { body: 'Chúng tôi đang kiểm tra link tải.' } });
    expect(reply.statusCode, reply.body).toBe(200);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/support/${ticketId}`, headers: asStaff() });
    expect(detail.json().data.status).toBe('waiting');
    expect(detail.json().data.sla_breached).toBe(false);
    expect(detail.json().data.messages).toHaveLength(1);
    expect(detail.json().data.messages[0]).toMatchObject({ sender_type: 'staff', locale: 'vi' });

    const customerReply = await ctx.app.inject({ method: 'POST', url: `/api/v1/support/tickets/${ticketId}/reply`, headers: asCustomer(), payload: { body: 'Vẫn chưa tải được.' } });
    expect(customerReply.statusCode).toBe(200);
    const resolved = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/support/${ticketId}/status`, headers: asStaff(), payload: { status: 'resolved' } });
    expect(resolved.json().data.status).toBe('resolved');
    const closed = await ctx.app.inject({ method: 'POST', url: `/api/v1/support/tickets/${ticketId}/close`, headers: asCustomer() });
    expect(closed.json().data.status).toBe('closed');
    const closedReply = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/support/${ticketId}/reply`, headers: asStaff(), payload: { body: 'Muộn rồi.' } });
    expect(closedReply.statusCode).toBe(409);

    // Customers only see their own tickets; staff queue is forbidden for customers.
    const mine = await ctx.app.inject({ method: 'GET', url: '/api/v1/support/tickets', headers: asCustomer() });
    expect(mine.json().data).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/support', headers: asCustomer() })).statusCode).toBe(403);
  });
});
