import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

let ctx: TestContext;
let ownerCookie: string;
let ownerId: string;
let plainCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'pricing-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  ownerId = owner.id;
  const plain = await createUser(ctx, 'pricing-plain@example.com');
  plainCookie = plain.cookie;
});
afterAll(async () => ctx.close());

const get = (url: string, cookie?: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const send = (method: 'PUT' | 'POST', url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method, url, payload: payload as object, headers: { origin: ORIGIN, cookie } });

async function insertCategory(code: string): Promise<string> {
  const { rows } = await ctx.db.query<{ id: string }>(
    'INSERT INTO template_categories (code) VALUES ($1) RETURNING id',
    [code],
  );
  return rows[0]!.id;
}

interface SeedOptions {
  categoryId?: string | null;
  status?: 'draft' | 'published';
  withPlanPrice?: string;
  published?: boolean;
}

async function insertTemplate(slug: string, opts: SeedOptions = {}): Promise<{ id: string; planId: string | null }> {
  const { rows } = await ctx.db.query<{ id: string }>(
    'INSERT INTO templates (slug, owner_id, status, category_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [slug, ownerId, opts.status ?? 'draft', opts.categoryId ?? null],
  );
  const id = rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', $2, $3, 'published')",
    [id, `Mẫu ${slug}`, slug],
  );
  let planId: string | null = null;
  if (opts.withPlanPrice) {
    const plan = await ctx.db.query<{ id: string }>(
      `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
       VALUES ($1, 'selfhost', 'selfhost', $2, '{}'::jsonb, 'active') RETURNING id`,
      [id, { vi: 'Gói tự triển khai', en: 'Self-host package' }],
    );
    planId = plan.rows[0]!.id;
    await ctx.db.query(
      `INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from)
       VALUES ($1, 'VND', $2, 'one_time', now() - interval '1 day')`,
      [planId, opts.withPlanPrice],
    );
  }
  if (opts.published) {
    const sha = 'a'.repeat(63) + Math.floor(Math.random() * 10);
    const artifact = await ctx.db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
       VALUES ($1, $2, 4, 'image/jpeg', 'static_site', 'permanent') RETURNING id`,
      [`test/${slug}`, sha],
    );
    const heroDir = join(ctx.store.pathFor(`test/${slug}`), 'images');
    await mkdir(heroDir, { recursive: true });
    await writeFile(join(heroDir, 'hero.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const version = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
      [id, sha, artifact.rows[0]!.id],
    );
    await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [id, version.rows[0]!.id]);
  }
  return { id, planId };
}

async function overviewRow(templateId: string) {
  const res = await get('/api/v1/admin/templates/pricing-overview', ownerCookie);
  expect(res.statusCode).toBe(200);
  return (res.json().data as { id: string; current_price_minor: string | null; hidden: boolean }[]).find((r) => r.id === templateId);
}

describe('quick price (PUT /admin/templates/:id/quick-price)', () => {
  it('creates and activates the standard plan when the template has none', async () => {
    const { id } = await insertTemplate('qp-create');
    const before = await get(`/api/v1/admin/templates/${id}/detail`, ownerCookie);
    const res = await send('PUT', `/api/v1/admin/templates/${id}/quick-price`, { amount_minor: '750000' }, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ template_id: id, amount_minor: '750000', currency: 'VND', interval: 'one_time' });
    const row = await overviewRow(id);
    expect(row?.current_price_minor).toBe('750000');
    const plan = await ctx.db.query<{ code: string; status: string }>('SELECT code, status FROM plans WHERE template_id = $1', [id]);
    expect(plan.rows).toEqual([{ code: 'selfhost', status: 'active' }]);
    const after = await get(`/api/v1/admin/templates/${id}/detail`, ownerCookie);
    expect(after.json().meta.revision).toBe(before.json().meta.revision + 1);
  });

  it('appends a new effective price to the existing standard plan (history kept)', async () => {
    const { id, planId } = await insertTemplate('qp-append', { withPlanPrice: '100000' });
    const res = await send('PUT', `/api/v1/admin/templates/${id}/quick-price`, { amount_minor: 600000 }, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.plan_id).toBe(planId);
    const prices = await ctx.db.query<{ amount_minor: string; effective_to: Date | null }>(
      'SELECT amount_minor::text AS amount_minor, effective_to FROM plan_prices WHERE plan_id = $1 ORDER BY effective_from',
      [planId],
    );
    expect(prices.rows).toHaveLength(2);
    expect(prices.rows[0]).toMatchObject({ amount_minor: '100000' });
    expect(prices.rows[0]!.effective_to).not.toBeNull();
    expect(prices.rows[1]).toMatchObject({ amount_minor: '600000', effective_to: null });
    expect((await overviewRow(id))?.current_price_minor).toBe('600000');
  });

  it('rejects non-positive amounts and users without pricing:write', async () => {
    const { id } = await insertTemplate('qp-invalid');
    const zero = await send('PUT', `/api/v1/admin/templates/${id}/quick-price`, { amount_minor: '0' }, ownerCookie);
    expect(zero.statusCode).toBe(422);
    const negative = await send('PUT', `/api/v1/admin/templates/${id}/quick-price`, { amount_minor: -5 }, ownerCookie);
    expect(negative.statusCode).toBe(422);
    const forbidden = await send('PUT', `/api/v1/admin/templates/${id}/quick-price`, { amount_minor: '1000' }, plainCookie);
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('bulk price (POST /admin/templates/bulk-price)', () => {
  it('sets the price for every template in a category and leaves others untouched', async () => {
    const catA = await insertCategory('bulk-a');
    const catB = await insertCategory('bulk-b');
    const a1 = await insertTemplate('bulk-a1', { categoryId: catA });
    const a2 = await insertTemplate('bulk-a2', { categoryId: catA, withPlanPrice: '111000' });
    const b1 = await insertTemplate('bulk-b1', { categoryId: catB, withPlanPrice: '222000' });
    const res = await send('POST', '/api/v1/admin/templates/bulk-price', { amount_minor: '300000', scope: { type: 'category', category_id: catA } }, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ updated_count: 2, failure_count: 0 });
    expect((await overviewRow(a1.id))?.current_price_minor).toBe('300000');
    expect((await overviewRow(a2.id))?.current_price_minor).toBe('300000');
    expect((await overviewRow(b1.id))?.current_price_minor).toBe('222000');
  });

  it('returns 400 when the scope matches zero templates', async () => {
    const emptyCat = await insertCategory('bulk-empty');
    const res = await send('POST', '/api/v1/admin/templates/bulk-price', { amount_minor: '300000', scope: { type: 'category', category_id: emptyCat } }, ownerCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bulk.scope_empty');
  });

  it('reports unknown ids as per-template failures in ids scope', async () => {
    const known = await insertTemplate('bulk-ids1');
    const bogus = '123e4567-e89b-42d3-a456-426614174000';
    const res = await send('POST', '/api/v1/admin/templates/bulk-price', { amount_minor: '450000', scope: { type: 'ids', template_ids: [known.id, bogus] } }, ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ updated_count: 1, failure_count: 1 });
    expect(res.json().data.failures).toEqual([{ template_id: bogus, code: 'resource.not_found' }]);
    expect((await overviewRow(known.id))?.current_price_minor).toBe('450000');
  });
});

describe('visibility (hidden flag)', () => {
  it('hides a published template from list, detail and preview-image; unhide restores it', async () => {
    const { id } = await insertTemplate('vis-public', { status: 'published', published: true, withPlanPrice: '499000' });

    const listBefore = await get('/api/v1/templates');
    expect((listBefore.json().data as { slug: string }[]).some((r) => r.slug === 'vis-public')).toBe(true);
    expect((await get('/api/v1/templates/vis-public')).statusCode).toBe(200);
    expect((await get('/api/v1/templates/vis-public/preview-image')).statusCode).toBe(200);

    const hide = await send('POST', `/api/v1/admin/templates/${id}/visibility`, { hidden: true }, ownerCookie);
    expect(hide.statusCode).toBe(200);
    expect(hide.json().data).toEqual({ id, hidden: true });
    expect((await overviewRow(id))?.hidden).toBe(true);

    const listAfter = await get('/api/v1/templates');
    expect((listAfter.json().data as { slug: string }[]).some((r) => r.slug === 'vis-public')).toBe(false);
    expect((await get('/api/v1/templates/vis-public')).statusCode).toBe(404);
    expect((await get('/api/v1/templates/vis-public/preview-image')).statusCode).toBe(404);

    const forbidden = await send('POST', `/api/v1/admin/templates/${id}/visibility`, { hidden: false }, plainCookie);
    expect(forbidden.statusCode).toBe(403);

    const show = await send('POST', `/api/v1/admin/templates/${id}/visibility`, { hidden: false }, ownerCookie);
    expect(show.statusCode).toBe(200);
    expect((await get('/api/v1/templates/vis-public')).statusCode).toBe(200);
    expect((await get('/api/v1/templates/vis-public/preview-image')).statusCode).toBe(200);
  });

  it('bulk-visibility hides and re-shows a whole category', async () => {
    const cat = await insertCategory('vis-cat');
    const t1 = await insertTemplate('vis-c1', { categoryId: cat, status: 'published', published: true });
    const t2 = await insertTemplate('vis-c2', { categoryId: cat, status: 'published', published: true });
    const hide = await send('POST', '/api/v1/admin/templates/bulk-visibility', { hidden: true, scope: { type: 'category', category_id: cat } }, ownerCookie);
    expect(hide.statusCode).toBe(200);
    expect(hide.json().data).toMatchObject({ hidden: true, updated_count: 2, failure_count: 0 });
    expect((await get('/api/v1/templates/vis-c1')).statusCode).toBe(404);
    expect((await get('/api/v1/templates/vis-c2')).statusCode).toBe(404);
    const show = await send('POST', '/api/v1/admin/templates/bulk-visibility', { hidden: false, scope: { type: 'category', category_id: cat } }, ownerCookie);
    expect(show.json().data).toMatchObject({ hidden: false, updated_count: 2, failure_count: 0 });
    expect((await get('/api/v1/templates/vis-c1')).statusCode).toBe(200);
    expect((await overviewRow(t1.id))?.hidden).toBe(false);
    expect((await overviewRow(t2.id))?.hidden).toBe(false);
  });
});
