import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** CAT-09 support: the public template summary carries the category code
 *  so the compare page can show who each template suits. */
let ctx: TestContext;

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN } });

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'summary-owner@example.com');
  const category = await ctx.db.query<{ id: string }>(
    "SELECT id FROM template_categories WHERE code = 'food'",
  );
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status, category_id) VALUES ('summary-cafe', $1, 'published', $2) RETURNING id",
    [owner.id, category.rows[0]!.id],
  );
  const id = template.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Cafe', 'summary-cafe', 'published')",
    [id],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/summary.zip', $1, 10, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['c'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"static-html","capabilities":["landing"],"locales":{"supported":["vi","en"]},"export":{"modes":["selfhost"]}}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [id, 'd'.repeat(64), artifact.rows[0]!.id],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [id, version.rows[0]!.id]);
});
afterAll(async () => ctx.close());

describe('public template summary', () => {
  it('exposes the category code on detail and list', async () => {
    const detail = await get('/api/v1/templates/summary-cafe');
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({ slug: 'summary-cafe', category: 'food' });
    const list = await get('/api/v1/templates?limit=10');
    expect(list.statusCode).toBe(200);
    const item = (list.json().data as { slug: string; category: string | null }[]).find((x) => x.slug === 'summary-cafe');
    expect(item?.category).toBe('food');
  });
});
