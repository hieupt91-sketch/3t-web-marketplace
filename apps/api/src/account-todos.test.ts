import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** ACC-01 — GET /me/todos aggregates only the caller's actionable items,
 *  in the doc's priority order, and stays empty for a settled account. */
let ctx: TestContext;
let u: { id: string; cookie: string };
let v: { id: string; cookie: string };
let siteId = '';

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });

async function seedTemplateVersion(ownerId: string, slug: string, sha: string): Promise<{ templateId: string; versionId: string }> {
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [slug, ownerId],
  );
  const tid = template.rows[0]!.id;
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 10, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    [`test/${slug}.zip`, sha],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"node-http","capabilities":["landing","admin"],"locales":{"supported":["vi"]},"export":{"modes":["hosted"]}}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [tid, sha, artifact.rows[0]!.id],
  );
  return { templateId: tid, versionId: version.rows[0]!.id };
}

beforeAll(async () => {
  ctx = await createTestContext();
  u = await createUser(ctx, 'todos-u@example.com');
  v = await createUser(ctx, 'todos-v@example.com');
  const { templateId, versionId } = await seedTemplateVersion(u.id, 'todos-shop', 'e'.repeat(64));

  // order awaiting payment
  const quote = await ctx.db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 150000, 150000, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [u.id],
  );
  await ctx.db.query(
    "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version) VALUES ($1, $2, 'awaiting_payment', 'VND', 150000, 150000, '2026-01')",
    [u.id, quote.rows[0]!.id],
  );
  // a paid order must NOT appear
  const quote2 = await ctx.db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 1, 1, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [u.id],
  );
  await ctx.db.query(
    "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version, paid_at) VALUES ($1, $2, 'paid', 'VND', 1, 1, '2026-01', now())",
    [u.id, quote2.rows[0]!.id],
  );

  // sites: one creating, one healthy with domain + expiring subscription
  const creating = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, 'Shop A', 'todos-a', 'creating') RETURNING id",
    [u.id, versionId],
  );
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [creating.rows[0]!.id, u.id]);
  const healthy = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, 'Shop B', 'todos-b', 'active') RETURNING id",
    [u.id, versionId],
  );
  siteId = healthy.rows[0]!.id;
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [siteId, u.id]);
  await ctx.db.query("INSERT INTO domains (site_id, hostname_ascii, verification_token_hash) VALUES ($1, 'shop-b.example.com', 'tok')", [siteId]);
  const plan = await ctx.db.query<{ id: string }>(
    "INSERT INTO plans (template_id, code, deployment_mode, name_json, status) VALUES ($1, 'hosted', 'hosted', '{\"vi\":\"H\"}'::jsonb, 'active') RETURNING id",
    [templateId],
  );
  await ctx.db.query(
    "INSERT INTO subscriptions (site_id, plan_id, current_period_start, current_period_end, status) VALUES ($1, $2, now() - interval '360 days', now() + interval '5 days', 'active')",
    [siteId, plan.rows[0]!.id],
  );
  // ticket waiting on the customer
  await ctx.db.query(
    "INSERT INTO support_tickets (requester_id, subject, body, locale, status) VALUES ($1, 'Hỏi về domain', 'Chi tiết câu hỏi', 'vi', 'waiting')",
    [u.id],
  );
  // another user's noise must not leak in
  const vQuote = await ctx.db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 9, 9, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [v.id],
  );
  await ctx.db.query(
    "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version) VALUES ($1, $2, 'awaiting_payment', 'VND', 9, 9, '2026-01')",
    [v.id, vQuote.rows[0]!.id],
  );
});
afterAll(async () => ctx.close());

describe('GET /me/todos (ACC-01)', () => {
  it('requires sign-in', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me/todos', headers: { origin: ORIGIN } })).statusCode).toBe(401);
  });

  it('returns the caller’s actionable groups in doc priority order', async () => {
    const res = await get('/api/v1/me/todos', u.cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { total: number; groups: { kind: string; count: number; items: Record<string, unknown>[] }[] };
    expect(data.groups.map((g) => g.kind)).toEqual(['payment_due', 'site_unfinished', 'domain_pending', 'subscription_expiring', 'ticket_waiting']);
    expect(data.total).toBe(5);
    const payment = data.groups[0]!;
    expect(payment.items[0]).toMatchObject({ total_minor: '150000', currency: 'VND' });
    expect(data.groups[1]!.items[0]).toMatchObject({ display_name: 'Shop A', status: 'creating' });
    expect(data.groups[2]!.items[0]).toMatchObject({ hostname: 'shop-b.example.com', site_id: siteId });
    expect(data.groups[4]!.items[0]).toMatchObject({ subject: 'Hỏi về domain' });
  });

  it('never leaks another user’s todos', async () => {
    const res = await get('/api/v1/me/todos', v.cookie);
    const data = res.json().data as { total: number; groups: { kind: string }[] };
    expect(data.total).toBe(1);
    expect(data.groups.map((g) => g.kind)).toEqual(['payment_due']);
  });
});
