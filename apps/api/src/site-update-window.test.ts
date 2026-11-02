import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** v44 — free-update window (owner rule 2026-11-02): a site may update
 *  for free within 12 months of its purchase entitlement. Past the
 *  deadline POST /sites/:id/update is refused with
 *  site.update_window_expired before any deployment/job exists; sites
 *  without an entitlement are not gated. GET /sites/:id exposes the
 *  deadline as updates_free_until. */
let ctx: TestContext;
let buyer: { id: string; cookie: string };
let templateId: string;
let planId: string;
let currentVersionId: string;
let nextVersionId: string;

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });

let seq = 0;
async function makeSite(entitlementAge: string | null): Promise<string> {
  seq += 1;
  let entitlementId: string | null = null;
  if (entitlementAge !== null) {
    const quote = await ctx.db.query<{ id: string }>(
      "INSERT INTO quotes (buyer_id, currency, subtotal_minor, total_minor, snapshot_json, expires_at) VALUES ($1, 'VND', 0, 0, '{}'::jsonb, now() + interval '1 hour') RETURNING id",
      [buyer.id],
    );
    const order = await ctx.db.query<{ id: string }>(
      "INSERT INTO orders (buyer_id, quote_id, status, currency, subtotal_minor, total_minor, terms_version, paid_at) VALUES ($1, $2, 'paid', 'VND', 0, 0, 'terms-2026-10', now()) RETURNING id",
      [buyer.id, quote.rows[0]!.id],
    );
    const item = await ctx.db.query<{ id: string }>(
      "INSERT INTO order_items (order_id, template_id, version_id, plan_id, deployment_mode, unit_price_minor, snapshot_json) VALUES ($1, $2, $3, $4, 'hosted', 0, '{}'::jsonb) RETURNING id",
      [order.rows[0]!.id, templateId, currentVersionId, planId],
    );
    const ent = await ctx.db.query<{ id: string }>(
      "INSERT INTO entitlements (order_item_id, user_id, template_id, version_id, mode, status, instance_limit) VALUES ($1, $2, $3, $4, 'hosted', 'active', 1) RETURNING id",
      [item.rows[0]!.id, buyer.id, templateId, currentVersionId],
    );
    entitlementId = ent.rows[0]!.id;
    await ctx.db.query(`UPDATE entitlements SET created_at = now() - interval '${entitlementAge}' WHERE id = $1`, [entitlementId]);
  }
  const site = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, default_locale, status) VALUES ($1, $2, $3, $4, $5, 'vi', 'active') RETURNING id",
    [buyer.id, entitlementId, currentVersionId, `Site ${seq}`, `upd-win-${seq}`, ],
  );
  return site.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  buyer = await createUser(ctx, 'upd-window@example.com');
  const owner = await createUser(ctx, 'upd-window-owner@example.com', 'platform_owner');
  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('upd-window-tpl', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  const plan = await ctx.db.query<{ id: string }>(
    "INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status) VALUES ($1, 'hosted', 'hosted', '{}'::jsonb, '{}'::jsonb, 'active') RETURNING id",
    [templateId],
  );
  planId = plan.rows[0]!.id;
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/upd-window', $1, 4, 'application/zip', 'runtime_bundle', 'permanent') RETURNING id`,
    ['e'.repeat(64)],
  );
  for (const semver of ['1.0.0', '1.0.1']) {
    const v = await ctx.db.query<{ id: string }>(
      `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
       VALUES ($1, $2, 1, '{}'::jsonb, 'node-http', $3, $4, $4, 'published') RETURNING id`,
      [templateId, semver, 'e'.repeat(64), artifact.rows[0]!.id],
    );
    if (semver === '1.0.0') currentVersionId = v.rows[0]!.id;
    else nextVersionId = v.rows[0]!.id;
  }
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /sites/:id/update free-update window', () => {
  it('allows the update while inside the 12-month window', async () => {
    const siteId = await makeSite('2 months');
    const res = await post(`/api/v1/sites/${siteId}/update`, { version_id: nextVersionId }, buyer.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.deployment_id).toBeTypeOf('string');
    expect(res.json().data.job_id).toBeTypeOf('string');
  });

  it('refuses with site.update_window_expired once past 12 months', async () => {
    const siteId = await makeSite('13 months');
    const res = await post(`/api/v1/sites/${siteId}/update`, { version_id: nextVersionId }, buyer.cookie);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('site.update_window_expired');
    const deps = await ctx.db.query("SELECT 1 FROM deployments WHERE site_id = $1 AND operation = 'update'", [siteId]);
    expect(deps.rows.length).toBe(0);
  });

  it('does not gate a site without an entitlement', async () => {
    const siteId = await makeSite(null);
    const res = await post(`/api/v1/sites/${siteId}/update`, { version_id: nextVersionId }, buyer.cookie);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('GET /sites/:id updates_free_until', () => {
  it('returns entitlement created_at + 12 months', async () => {
    const siteId = await makeSite('2 months');
    const res = await get(`/api/v1/sites/${siteId}`, buyer.cookie);
    expect(res.statusCode, res.body).toBe(200);
    const until = res.json().data.updates_free_until as string | null;
    expect(until).toBeTypeOf('string');
    const ent = await ctx.db.query<{ created_at: Date }>(
      'SELECT e.created_at FROM entitlements e JOIN sites s ON s.entitlement_id = e.id WHERE s.id = $1',
      [siteId],
    );
    const expected = new Date(ent.rows[0]!.created_at);
    expected.setMonth(expected.getMonth() + 12);
    // Postgres month-addition clamps month ends; JS setMonth can overflow
    // by a few days, so allow a small tolerance around the same anchor.
    expect(Math.abs(new Date(until!).getTime() - expected.getTime())).toBeLessThan(4 * 24 * 3600 * 1000);
  });

  it('returns null for a site without an entitlement', async () => {
    const siteId = await makeSite(null);
    const res = await get(`/api/v1/sites/${siteId}`, buyer.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.updates_free_until).toBeNull();
  });
});
