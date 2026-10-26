/**
 * M8 load acceptance (docs/10 §5, test-environment scale).
 * Seeds 1,000 published templates (vi+en) and 10,000 orders via SQL, then
 * measures: 50 concurrent catalog reads (target p95 < 500 ms, <1% 5xx)
 * and a paginated order list over 10,000 rows (target p95 < 800 ms).
 * Timings are in-process (inject, no WAN), so they measure query + handler
 * cost, not network — exactly what §5 excludes from its p95 budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let buyerCookie: string;

beforeAll(async () => {
  ctx = await createTestContext({});
  const owner = await createUser(ctx, 'load-owner@example.com', 'platform_owner');
  const buyer = await createUser(ctx, 'load-buyer@example.com');
  buyerCookie = buyer.cookie;
  const ownerId = owner.id;
  const buyerId = buyer.id;
  await ctx.db.query(
    `INSERT INTO artifacts (id, object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('00000000-0000-0000-0000-000000000001', 'load/seed.zip', $1, 100, 'application/zip', 'static_site', 'standard')`,
    ['0'.repeat(64)],
  );
  await ctx.db.query(
    `INSERT INTO templates (slug, owner_id, status)
     SELECT 'load-' || g, $1, 'published' FROM generate_series(1, 1000) g`,
    [ownerId],
  );
  await ctx.db.query(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     SELECT id, '1.0.0', 1, '{}'::jsonb, 'static-html', $1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'published'
     FROM templates WHERE slug LIKE 'load-%'`,
    ['1'.repeat(64)],
  );
  await ctx.db.query(
    `UPDATE templates t SET published_version_id = v.id
     FROM template_versions v WHERE v.template_id = t.id AND t.slug LIKE 'load-%'`,
  );
  await ctx.db.query(
    `INSERT INTO template_translations (template_id, locale, title, slug, status)
     SELECT id, 'vi', 'Mẫu ' || slug, slug, 'published' FROM templates WHERE slug LIKE 'load-%'`,
  );
  await ctx.db.query(
    `INSERT INTO template_translations (template_id, locale, title, slug, status)
     SELECT id, 'en', 'Template ' || slug, slug || '-en', 'published' FROM templates WHERE slug LIKE 'load-%'`,
  );
  await ctx.db.query(
    `WITH q AS (
       INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at)
       SELECT $1, 'VND', 1000000, 1000000, '{}'::jsonb, now() + interval '1 day' FROM generate_series(1, 10000)
       RETURNING id
     )
     INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version, paid_at)
     SELECT $1, id, 'paid', 'VND', 1000000, 1000000, 'terms-2026-10', now() FROM q`,
    [buyerId],
  );
});
afterAll(async () => ctx.close());

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

describe('release load', () => {
  it('serves 50 concurrent catalog reads within p95 < 500ms', async () => {
    const timings: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const start = performance.now();
        const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?limit=50&locale=vi' });
        timings.push(performance.now() - start);
        return res;
      }),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect((results[0]!.json().data as unknown[])).toHaveLength(50);
    const p = p95(timings);
    // Logged for the acceptance report; the hard assertion is the §5 budget.
    console.log(`catalog 50 concurrent: p95=${p.toFixed(1)}ms max=${Math.max(...timings).toFixed(1)}ms`);
    expect(p).toBeLessThan(500);
  }, 120_000);

  it('lists orders over 10,000 rows within p95 < 800ms', async () => {
    const timings: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const start = performance.now();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/orders?limit=50', headers: { cookie: buyerCookie } });
      timings.push(performance.now() - start);
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      expect((res.json().data as unknown[])).toHaveLength(50);
    }
    const p = p95(timings);
    console.log(`orders list over 10k rows: p95=${p.toFixed(1)}ms max=${Math.max(...timings).toFixed(1)}ms`);
    expect(p).toBeLessThan(800);
  }, 120_000);
});
