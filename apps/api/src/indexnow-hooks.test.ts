import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/**
 * IndexNow hooks (routes/admin-templates.ts): publishing, archiving and
 * hiding/unhiding a template are the moments its public URLs appear, change
 * or disappear, so each must fire exactly one fire-and-forget submission
 * with the template's URL set. INDEXNOW_ENABLED=true opts the test env in
 * (production submits unconditionally); fetch is stubbed and captured.
 */
let ctx: TestContext;
let ownerCookie: string;
let ownerId: string;
let fetchBodies: Record<string, unknown>[] = [];

const EXPECTED_URLS = [
  'https://webmaket.com/vi/templates/indexnow-hook-1',
  'https://webmaket.com/en/templates/indexnow-hook-1',
  'https://webmaket.com/vi/templates',
  'https://webmaket.com/en/templates',
];

beforeAll(async () => {
  process.env.INDEXNOW_ENABLED = 'true';
  vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
    fetchBodies.push(JSON.parse(init.body!) as Record<string, unknown>);
    return { status: 202 };
  });
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'indexnow-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  ownerId = owner.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.INDEXNOW_ENABLED;
  await ctx.close();
});

const send = (url: string, payload: unknown, ifMatch?: number) =>
  ctx.app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { origin: ORIGIN, cookie: ownerCookie, ...(ifMatch !== undefined ? { 'if-match': `"${ifMatch}"` } : {}) },
  });

async function rowVersion(id: string): Promise<number> {
  const { rows } = await ctx.db.query<{ row_version: number }>('SELECT row_version FROM templates WHERE id = $1', [id]);
  return rows[0]!.row_version;
}

async function seedPublishable(slug: string): Promise<string> {
  const { rows } = await ctx.db.query<{ id: string }>(
    'INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, $3) RETURNING id',
    [slug, ownerId, 'draft'],
  );
  const id = rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', $2, $3, 'published')",
    [id, `Mẫu ${slug}`, slug],
  );
  const sha = 'e'.repeat(64);
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    [`test/${slug}`, sha],
  );
  await ctx.db.query(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"node-http","capabilities":["landing","admin"],"locales":{"supported":["vi","en"]},"export":{"modes":["selfhost"]}}'::jsonb, 'node-http', $2, $3, $3, 'ready')`,
    [id, sha, artifact.rows[0]!.id],
  );
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'selfhost', 'selfhost', '{"vi":"Gói tự triển khai","en":"Self-host package"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [id],
  );
  await ctx.db.query(
    `INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from)
     VALUES ($1, 'VND', 100000, 'one_time', now() - interval '1 day')`,
    [plan.rows[0]!.id],
  );
  return id;
}

describe('indexnow hooks on template lifecycle', () => {
  it('pings on publish, hide, bulk-unhide and archive — once per event, with the template URL set', async () => {
    const id = await seedPublishable('indexnow-hook-1');
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const publish = await send(`/api/v1/admin/templates/${id}/publish`, {}, await rowVersion(id));
    expect(publish.statusCode).toBe(200);
    expect(publish.json().data).toEqual({ status: 'published' });
    await flush();
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({ host: 'webmaket.com', urlList: EXPECTED_URLS });

    const hide = await send(`/api/v1/admin/templates/${id}/visibility`, { hidden: true });
    expect(hide.statusCode).toBe(200);
    await flush();
    expect(fetchBodies).toHaveLength(2);
    expect(fetchBodies[1]).toMatchObject({ urlList: EXPECTED_URLS });

    const bulkShow = await send('/api/v1/admin/templates/bulk-visibility', { hidden: false, scope: { type: 'ids', template_ids: [id] } });
    expect(bulkShow.statusCode).toBe(200);
    expect(bulkShow.json().data.updated_count).toBe(1);
    await flush();
    expect(fetchBodies).toHaveLength(3);
    expect(fetchBodies[2]).toMatchObject({ urlList: EXPECTED_URLS });

    const archive = await send(`/api/v1/admin/templates/${id}/archive`, {}, await rowVersion(id));
    expect(archive.statusCode).toBe(200);
    expect(archive.json().data).toEqual({ status: 'archived' });
    await flush();
    expect(fetchBodies).toHaveLength(4);
    expect(fetchBodies[3]).toMatchObject({ urlList: EXPECTED_URLS });

    const { rows } = await ctx.db.query<{ status: string }>('SELECT status FROM templates WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('archived');
  });
});
