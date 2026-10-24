/**
 * M3 CATALOG: an imported template is edited, priced, gated and published, then becomes visible
 * on the public storefront with plans and a starting price. Covers A06/A08/A09 and REQ-01/16.
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
let closePreview: () => Promise<void>;

beforeAll(async () => {
  ctx = await createTestContext();
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
});

afterAll(async () => {
  await closePreview();
  await ctx.close();
});

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });

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
    const job = await claimJob(ctx.db, 'test-worker', [IMPORT_JOB_TYPE], 60);
    if (!job) return;
    await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
  }
}

/** Import the bundled static fixture and return the ready template's id. `slug` overrides the manifest slug. */
async function importFixture(slug?: string): Promise<string> {
  let entries = await walk(join(REPO_ROOT, 'examples/static-landing'));
  if (slug) {
    entries = entries.map((e) =>
      e.name === 'template.manifest.json' ? { ...e, data: Buffer.from(String(e.data).replace('"landing-fixture"', `"${slug}"`)) } : e,
    );
  }
  const zip = buildZip(entries);
  const session = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/upload-sessions',
    headers: admin(),
    payload: { filename: 'landing.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true },
  });
  await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
  const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
  await drainWorker();
  const importId = created.json().data.resource_id;
  const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${importId}`, headers: admin() });
  expect(detail.json().data.status).toBe('ready');
  return detail.json().data.draft.template_id as string;
}

async function templateDetail(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${id}/detail`, headers: admin() });
  expect(res.statusCode, res.body).toBe(200);
  return { data: res.json().data, etag: res.headers.etag as string };
}

async function putTranslation(id: string, locale: string, extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/admin/templates/${id}/translations/${locale}`,
    headers: admin(),
    payload: { title: `Landing ${locale}`, summary: `Summary ${locale}`, slug: `landing-${locale}`, status: 'published', ...extra },
  });
}

describe('publish gates and catalog visibility', () => {
  let templateId: string;

  it('blocks publishing until every gate passes, then publishes', async () => {
    templateId = await importFixture();

    // Draft is invisible publicly and not yet publishable.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/templates' })).json().data).toEqual([]);
    let detail = await templateDetail(templateId);
    const gatesByCode = (d: typeof detail.data) => Object.fromEntries(d.publish.gates.map((g: { code: string; passed: boolean }) => [g.code, g.passed]));
    expect(detail.data.publish.ready).toBe(false);
    expect(gatesByCode(detail.data)).toMatchObject({ demo_ready: true, default_translation: false, has_priced_plan: false, export_modes: false });

    const earlyPublish = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail.etag } });
    expect(earlyPublish.statusCode).toBe(409);
    expect(earlyPublish.json().error.field_errors.map((f: { field: string }) => f.field)).toEqual(expect.arrayContaining(['default_translation', 'has_priced_plan']));

    // Publish the default (vi) translation.
    expect((await putTranslation(templateId, 'vi')).statusCode).toBe(200);

    // Create a self-host plan, price it, then activate it.
    const plan = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/templates/${templateId}/plans`,
      headers: admin(),
      payload: { code: 'selfhost-standard', deployment_mode: 'selfhost', name: { vi: 'Tự triển khai', en: 'Self-host' }, limits: { instance_limit: 1, updates_months: 12 } },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const planId = plan.json().data.id;

    const planDetail = () => ctx.app.inject({ method: 'GET', url: `/api/v1/admin/templates/${templateId}/detail`, headers: admin() }).then((r) => r.json().data.plans.find((p: { id: string }) => p.id === planId));
    const beforePriceEtag = `"${(await planDetail()).row_version}"`;
    const activateUnpriced = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': beforePriceEtag }, payload: { status: 'active' } });
    expect(activateUnpriced.statusCode).toBe(409);
    expect(activateUnpriced.json().error.code).toBe('plan.no_current_price');

    const price = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1500000', interval: 'one_time' } });
    expect(price.statusCode, price.body).toBe(201);
    const activate = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/plans/${planId}`, headers: { ...admin(), 'if-match': `"${(await planDetail()).row_version}"` }, payload: { status: 'active' } });
    expect(activate.statusCode, activate.body).toBe(200);

    detail = await templateDetail(templateId);
    expect(detail.data.publish.ready).toBe(true);

    const published = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { ...admin(), 'if-match': detail.etag } });
    expect(published.statusCode, published.body).toBe(200);
  });

  it('shows the published template with a starting price and plans to the public', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi' });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({
      slug: 'landing-vi',
      translation_status: 'published',
      starting_prices: [{ deployment_mode: 'selfhost', amount_minor: '1500000', currency: 'VND', interval: 'one_time' }],
    });

    const detail = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates/landing-vi?locale=vi' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.plans).toEqual([
      expect.objectContaining({ code: 'selfhost-standard', deployment_mode: 'selfhost', name: { vi: 'Tự triển khai', en: 'Self-host' }, prices: [{ interval: 'one_time', amount_minor: '1500000', currency: 'VND' }] }),
    ]);

    // English requested but only vi/en translations published — en translation not yet added → fallback.
    const en = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=en' });
    expect(en.json().data[0].translation_status).toBe('fallback');
    expect(en.json().data[0].resolved_locale).toBe('vi');
  });

  it('exposes a public demo URL, mode/capability filters and diacritic-insensitive search', async () => {
    // Give the template a Vietnamese title to exercise unaccent search.
    expect((await putTranslation(templateId, 'vi', { title: 'Nhà hàng Đà Lạt', slug: 'landing-vi' })).statusCode).toBe(200);

    const detail = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates/landing-vi?locale=vi' });
    expect(detail.json().data.demo).toMatchObject({ available: true, mode: 'publicReadonly' });
    expect(detail.json().data.demo.url).toMatch(/^http:\/\/[a-z2-7]{32}\.preview\.localhost:4100\/$/);

    const noDiacritics = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=vi&q=nha hang da lat' });
    expect(noDiacritics.json().data.map((t: { slug: string }) => t.slug)).toContain('landing-vi');
    const withDiacritics = await ctx.app.inject({ method: 'GET', url: `/api/v1/templates?locale=vi&q=${encodeURIComponent('Đà Lạt')}` });
    expect(withDiacritics.json().data).toHaveLength(1);

    const selfhost = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?mode=selfhost' });
    expect(selfhost.json().data).toHaveLength(1);
    const hosted = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?mode=hosted' });
    expect(hosted.json().data).toEqual([]);
    const landing = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?capability=landing' });
    expect(landing.json().data).toHaveLength(1);
    const adminCap = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?capability=admin' });
    expect(adminCap.json().data).toEqual([]);
  });

  it('caps the previous price when a new effective price is added (A08)', async () => {
    const detail = await templateDetail(templateId);
    const planId = detail.data.plans[0].id as string;
    const future = new Date(Date.now() + 60_000).toISOString();
    const added = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '1800000', interval: 'one_time', effective_from: future } });
    expect(added.statusCode, added.body).toBe(201);
    const after = await templateDetail(templateId);
    const prices = after.data.plans[0].prices as { amount_minor: string; effective_to: string | null }[];
    expect(prices).toHaveLength(2);
    const old = prices.find((p) => p.amount_minor === '1500000')!;
    expect(old.effective_to).toBe(future);
    // The current (now) price is still the old one until the new one becomes effective.
    const current = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates/landing-vi' });
    expect(current.json().data.plans[0].prices).toEqual([{ interval: 'one_time', amount_minor: '1500000', currency: 'VND' }]);
  });

  it('rejects overlapping prices and invalid amounts', async () => {
    const detail = await templateDetail(templateId);
    const planId = detail.data.plans[0].id as string;
    const overlap = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '999', interval: 'one_time', effective_from: '2000-01-01T00:00:00Z' } });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error.code).toBe('price.overlap');
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/prices`, headers: admin(), payload: { amount_minor: '12.50', interval: 'one_time' } });
    expect(bad.statusCode).toBe(422);
  });

  it('enforces slug uniqueness per locale and optimistic locking on edits', async () => {
    const other = await importFixture('landing-two');
    expect(other).not.toBe(templateId);
    const conflict = await putTranslation(other, 'vi', { slug: 'landing-vi' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('translation.slug_taken');

    const detail = await templateDetail(other);
    const stale = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/templates/${other}`, headers: { ...admin(), 'if-match': '"999"' }, payload: { category_id: null } });
    expect(stale.statusCode).toBe(412);
    const ok = await ctx.app.inject({ method: 'PATCH', url: `/api/v1/admin/templates/${other}`, headers: { ...admin(), 'if-match': detail.etag }, payload: { category_id: null } });
    expect(ok.statusCode).toBe(200);
  });

  it('archive removes the template from the public catalog but keeps its version', async () => {
    const detail = await templateDetail(templateId);
    const archived = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/archive`, headers: { ...admin(), 'if-match': detail.etag } });
    expect(archived.statusCode, archived.body).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/templates' })).json().data).toEqual([]);
    const after = await templateDetail(templateId);
    expect(after.data.status).toBe('archived');
    expect(after.data.published_version_id).not.toBeNull();
  });

  it('lets an editor draft pricing but reserves publish for template:publish (docs/01 §1)', async () => {
    const editor = await createUser(ctx, 'editor@example.com', 'template_editor');
    // "Giá nháp": template_editor holds pricing:write and may create draft plans/prices.
    const planAttempt = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/templates/${templateId}/plans`,
      headers: { cookie: editor.cookie, origin: ORIGIN },
      payload: { code: 'draft-plan', deployment_mode: 'selfhost', name: { vi: 'x' } },
    });
    expect(planAttempt.statusCode).toBe(201);
    // But publishing needs template:publish, which the editor lacks.
    const publishAttempt = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/publish`, headers: { cookie: editor.cookie, origin: ORIGIN, 'if-match': '"1"' } });
    expect(publishAttempt.statusCode).toBe(403);
    // A plain customer cannot touch admin pricing at all.
    const customer = await createUser(ctx, 'buyer@example.com');
    const denied = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/templates/${templateId}/plans`, headers: { cookie: customer.cookie, origin: ORIGIN }, payload: { code: 'y', deployment_mode: 'selfhost', name: { vi: 'y' } } });
    expect(denied.statusCode).toBe(403);
  });
});
