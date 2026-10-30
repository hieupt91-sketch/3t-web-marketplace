import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** DEP-06 — subdomain holds with TTL: reserve, two-customer race (UX-12),
 *  lazy expiry, release, consumption by site creation, admin TTL setting. */
let ctx: TestContext;
let a: { id: string; cookie: string };
let b: { id: string; cookie: string };
let entA = '';
let entB = '';

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, payload: payload as object | undefined });
const reserve = (cookie: string, subdomain: string, entitlement_id?: string) =>
  call('POST', '/api/v1/sites/subdomain-reservations', cookie, { subdomain, entitlement_id });
const check = (cookie: string, subdomain: string) =>
  call('GET', `/api/v1/sites/check-subdomain?subdomain=${subdomain}`, cookie);

async function seedHostedEntitlement(userId: string, suffix: string): Promise<string> {
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [`resv-${suffix}`, userId],
  );
  const tid = template.rows[0]!.id;
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 10, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    [`test/resv-${suffix}.zip`, suffix.repeat(64).slice(0, 64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"static-html","capabilities":["landing"],"locales":{"supported":["vi"]},"export":{"modes":["hosted"]}}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [tid, suffix.repeat(64).slice(0, 64), artifact.rows[0]!.id],
  );
  const plan = await ctx.db.query<{ id: string }>(
    "INSERT INTO plans (template_id, code, deployment_mode, name_json, status, limits_json) VALUES ($1, 'hosted', 'hosted', '{\"vi\":\"H\"}'::jsonb, 'active', '{\"instance_limit\":3,\"grace_days\":7,\"retention_days\":30}'::jsonb) RETURNING id",
    [tid],
  );
  const quote = await ctx.db.query<{ id: string }>(
    "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 0, 0, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
    [userId],
  );
  const order = await ctx.db.query<{ id: string }>(
    "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version, paid_at) VALUES ($1, $2, 'paid', 'VND', 0, 0, '2026-01', now()) RETURNING id",
    [userId, quote.rows[0]!.id],
  );
  const item = await ctx.db.query<{ id: string }>(
    "INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json) VALUES ($1, $2, $3, $4, 'hosted', 0, '{}'::jsonb) RETURNING id",
    [order.rows[0]!.id, tid, version.rows[0]!.id, plan.rows[0]!.id],
  );
  const ent = await ctx.db.query<{ id: string }>(
    "INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit) VALUES ($1, $2, $3, $4, 'hosted', 'active', 3) RETURNING id",
    [item.rows[0]!.id, userId, tid, version.rows[0]!.id],
  );
  return ent.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  a = await createUser(ctx, 'resv-a@example.com');
  b = await createUser(ctx, 'resv-b@example.com');
  entA = await seedHostedEntitlement(a.id, 'a');
  entB = await seedHostedEntitlement(b.id, 'b');
});
afterAll(async () => ctx.close());

describe('subdomain reservations (DEP-06)', () => {
  it('reserving holds the name: holder can proceed, others see it held (UX-12)', async () => {
    const before = Date.now();
    const res = await reserve(a.cookie, 'my-cafe', entA);
    expect(res.statusCode).toBe(201);
    const expires = new Date(res.json().data.expires_at).getTime();
    expect(expires - before).toBeGreaterThan(13 * 60_000);
    expect(expires - before).toBeLessThan(17 * 60_000);

    const forB = await check(b.cookie, 'my-cafe');
    expect(forB.json().data).toMatchObject({ available: false, reason: 'held' });
    const forA = await check(a.cookie, 'my-cafe');
    expect(forA.json().data).toMatchObject({ available: true, held_by_you: true });

    const bTry = await reserve(b.cookie, 'my-cafe', entB);
    expect(bTry.statusCode).toBe(409);
    expect(bTry.json().error.code).toBe('site.subdomain_held');

    const renew = await reserve(a.cookie, 'my-cafe', entA);
    expect(renew.statusCode).toBe(200);
  });

  it('another customer cannot create a site under a held name; the holder consumes the hold', async () => {
    const bSite = await call('POST', '/api/v1/sites', b.cookie, { entitlement_id: entB, subdomain: 'my-cafe', display_name: 'B cafe', default_locale: 'vi' });
    expect(bSite.statusCode).toBe(409);
    expect(bSite.json().error.code).toBe('site.subdomain_held');

    const aSite = await call('POST', '/api/v1/sites', a.cookie, { entitlement_id: entA, subdomain: 'my-cafe', display_name: 'A cafe', default_locale: 'vi' });
    expect(aSite.statusCode).toBe(201);
    const { rows } = await ctx.db.query<{ status: string }>("SELECT status FROM subdomain_reservations WHERE subdomain = 'my-cafe'");
    expect(rows[0]!.status).toBe('consumed');
    const nowCheck = await check(b.cookie, 'my-cafe');
    expect(nowCheck.json().data).toMatchObject({ available: false, reason: 'taken' });
  });

  it('an expired hold frees the name and is lazily marked expired', async () => {
    expect((await reserve(a.cookie, 'old-name', entA)).statusCode).toBe(201);
    await ctx.db.query("UPDATE subdomain_reservations SET expires_at = now() - interval '1 minute' WHERE subdomain = 'old-name'");
    const forB = await check(b.cookie, 'old-name');
    expect(forB.json().data).toMatchObject({ available: true });
    const { rows } = await ctx.db.query<{ status: string }>("SELECT status FROM subdomain_reservations WHERE subdomain = 'old-name'");
    expect(rows[0]!.status).toBe('expired');
    expect((await reserve(b.cookie, 'old-name', entB)).statusCode).toBe(201);
  });

  it('release frees the name immediately; invalid and reserved names are rejected', async () => {
    expect((await reserve(a.cookie, 'temp-name', entA)).statusCode).toBe(201);
    expect((await call('DELETE', '/api/v1/sites/subdomain-reservations/temp-name', a.cookie)).statusCode).toBe(204);
    expect((await reserve(b.cookie, 'temp-name', entB)).statusCode).toBe(201);
    expect((await reserve(a.cookie, 'BAD NAME!', entA)).statusCode).toBe(422);
    expect((await reserve(a.cookie, 'admin', entA)).statusCode).toBe(422);
    const mine = await call('GET', '/api/v1/sites/subdomain-reservations', b.cookie);
    expect((mine.json().data as { subdomain: string }[]).map((r) => r.subdomain)).toEqual(expect.arrayContaining(['old-name', 'temp-name']));
  });

  it('the hold TTL is an admin setting (settings:manage only, 1..1440)', async () => {
    const staff = await createUser(ctx, 'resv-staff@example.com', 'platform_owner');
    expect((await call('GET', '/api/v1/admin/settings/subdomain-reservation', staff.cookie)).json().data).toEqual({ ttl_minutes: 15 });
    expect((await call('POST', '/api/v1/admin/settings/subdomain-reservation', staff.cookie, { ttl_minutes: 30 })).json().data).toEqual({ ttl_minutes: 30 });
    expect((await call('GET', '/api/v1/admin/settings/subdomain-reservation', staff.cookie)).json().data).toEqual({ ttl_minutes: 30 });
    expect((await call('POST', '/api/v1/admin/settings/subdomain-reservation', staff.cookie, { ttl_minutes: 0 })).statusCode).toBe(422);
    expect((await call('POST', '/api/v1/admin/settings/subdomain-reservation', a.cookie, { ttl_minutes: 30 })).statusCode).toBe(403);
    // leave the setting back at the doc default for other suites
    await call('POST', '/api/v1/admin/settings/subdomain-reservation', staff.cookie, { ttl_minutes: 15 });
  });
});
