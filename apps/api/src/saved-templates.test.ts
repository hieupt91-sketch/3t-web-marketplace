import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** CAT-08 / ACC-06: saved templates — save/unsave/list/merge, eligibility
 *  (only once-public templates), per-user isolation, live availability. */
let ctx: TestContext;
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };
let publishedId = '';
let archivedId = '';
let hiddenId = '';
let draftId = '';

const get = (url: string, cookie?: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const post = (url: string, payload: unknown, cookie?: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const del = (url: string, cookie?: string) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

async function seedTemplate(slug: string, status: 'published' | 'archived' | 'draft', opts: { hidden?: boolean; withVersion?: boolean } = {}): Promise<string> {
  const { rows } = await ctx.db.query<{ id: string }>(
    'INSERT INTO templates (slug, owner_id, status, hidden) VALUES ($1, $2, $3, $4) RETURNING id',
    [slug, alice.id, status, opts.hidden ?? false],
  );
  const id = rows[0]!.id;
  if (opts.withVersion !== false) {
    const artifact = await ctx.db.query<{ id: string }>(
      `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
       VALUES ($1, $2, 10, 'application/zip', 'static_site', 'permanent') RETURNING id`,
      [`test/${slug}.zip`, 'a'.repeat(64)],
    );
    await ctx.db.query(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published')`,
      [id, 'b'.repeat(64), artifact.rows[0]!.id],
    );
  }
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await createUser(ctx, 'saved-alice@example.com');
  bob = await createUser(ctx, 'saved-bob@example.com');
  publishedId = await seedTemplate('saved-published', 'published');
  archivedId = await seedTemplate('saved-archived', 'archived');
  hiddenId = await seedTemplate('saved-hidden', 'published', { hidden: true });
  draftId = await seedTemplate('saved-draft', 'draft');
});
afterAll(async () => ctx.close());

describe('saved templates', () => {
  it('requires authentication', async () => {
    expect((await get('/api/v1/me/saved-templates')).statusCode).toBe(401);
    expect((await post('/api/v1/me/saved-templates', { template_id: publishedId })).statusCode).toBe(401);
    expect((await del(`/api/v1/me/saved-templates/${publishedId}`)).statusCode).toBe(401);
  });

  it('saves, lists with availability, and is idempotent', async () => {
    const first = await post('/api/v1/me/saved-templates', { template_id: publishedId }, alice.cookie);
    expect(first.statusCode).toBe(201);
    const again = await post('/api/v1/me/saved-templates', { template_id: publishedId }, alice.cookie);
    expect(again.statusCode).toBe(200);
    const list = await get('/api/v1/me/saved-templates', alice.cookie);
    expect(list.statusCode).toBe(200);
    const data = (list.json() as { data: { template_id: string; slug: string; available: boolean }[] }).data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ template_id: publishedId, slug: 'saved-published', available: true });
  });

  it('rejects drafts and unknown ids with 404', async () => {
    expect((await post('/api/v1/me/saved-templates', { template_id: draftId }, alice.cookie)).statusCode).toBe(404);
    expect((await post('/api/v1/me/saved-templates', { template_id: randomUUID() }, alice.cookie)).statusCode).toBe(404);
    expect((await post('/api/v1/me/saved-templates', { template_id: 'not-a-uuid' }, alice.cookie)).statusCode).toBe(404);
  });

  it('keeps archived and hidden templates listed but flags availability honestly', async () => {
    expect((await post('/api/v1/me/saved-templates', { template_id: archivedId }, alice.cookie)).statusCode).toBe(201);
    expect((await post('/api/v1/me/saved-templates', { template_id: hiddenId }, alice.cookie)).statusCode).toBe(201);
    const data = (await get('/api/v1/me/saved-templates', alice.cookie)).json().data as { template_id: string; available: boolean; template_status: string }[];
    const byId = new Map(data.map((r) => [r.template_id, r]));
    expect(byId.get(archivedId)).toMatchObject({ available: false, template_status: 'archived' });
    expect(byId.get(hiddenId)).toMatchObject({ available: false, template_status: 'published' });
    expect(byId.get(publishedId)).toMatchObject({ available: true });
  });

  it('unsaves idempotently and isolates users', async () => {
    expect((await del(`/api/v1/me/saved-templates/${hiddenId}`, alice.cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/me/saved-templates/${hiddenId}`, alice.cookie)).statusCode).toBe(204);
    const aliceList = (await get('/api/v1/me/saved-templates', alice.cookie)).json().data as unknown[];
    expect(aliceList).toHaveLength(2);
    const bobList = (await get('/api/v1/me/saved-templates', bob.cookie)).json().data as unknown[];
    expect(bobList).toHaveLength(0);
  });

  it('merges a guest list, dropping drafts, unknown and malformed ids', async () => {
    const res = await post('/api/v1/me/saved-templates/merge', { template_ids: [publishedId, draftId, randomUUID(), 'junk', publishedId] }, bob.cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { template_id: string }[];
    expect(data.map((r) => r.template_id)).toEqual([publishedId]);
  });
});
