import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** Docs/12 — customer content backups for dynamic sites: the platform
 *  surface over the template family's own data/content.json backup.
 *  Ownership (site owner only), dynamic-only, shape validation on
 *  upload, step-up + name confirmation on restores. */
let ctx: TestContext;
let a: { id: string; cookie: string };
let b: { id: string; cookie: string };
let dynamicSite = '';
let staticSite = '';

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { origin: ORIGIN, cookie }, payload: payload as object | undefined });

const VALID_CONTENT = {
  site: { name: 'Quán Đông' },
  hero: { title: 'Chào mừng' },
  menu: { items: [{ name: 'Phở', price: 50000 }] },
  spaces: { items: [] },
  reviews: { items: [] },
  faqs: { items: [] },
  bookingSteps: { items: [] },
  bookingForm: { fields: [] },
  nav: { links: [] },
  theme: { primary: '#000000' },
  footer: { text: '©' },
};

async function seedSite(ownerId: string, slug: string, adapter: string, capabilities: string[], sha: string): Promise<string> {
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [slug, ownerId],
  );
  const tid = template.rows[0]!.id;
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 10, 'application/zip', 'runtime_bundle', 'permanent') RETURNING id`,
    [`test/${slug}.zip`, sha],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, $2::jsonb, $3, $4, $5, $5, 'published') RETURNING id`,
    [tid, JSON.stringify({ adapter, capabilities, locales: { supported: ['vi'] }, export: { modes: ['hosted'] } }), adapter, sha, artifact.rows[0]!.id],
  );
  const site = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
    [ownerId, version.rows[0]!.id, slug === 'cb-dyn' ? 'Quan Dong A' : 'Tinh A', slug],
  );
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [site.rows[0]!.id, ownerId]);
  return site.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  a = await createUser(ctx, 'cb-a@example.com');
  b = await createUser(ctx, 'cb-b@example.com');
  dynamicSite = await seedSite(a.id, 'cb-dyn', 'node-http', ['landing', 'cms.pages', 'admin', 'contact'], 'f'.repeat(64));
  staticSite = await seedSite(a.id, 'cb-static', 'static-html', ['landing'], '9'.repeat(64));
  const stepUp = await call('POST', '/api/v1/auth/step-up', a.cookie, { password: 'correct horse battery staple' });
  if (stepUp.statusCode !== 200) throw new Error(`step-up failed ${stepUp.statusCode}`);
});
afterAll(async () => ctx.close());

describe('dynamic content backups', () => {
  it('rejects static sites and non-owners', async () => {
    const onStatic = await call('POST', `/api/v1/sites/${staticSite}/content-backups`, a.cookie);
    expect(onStatic.statusCode).toBe(409);
    expect(onStatic.json().error.code).toBe('site.not_dynamic');
    expect((await call('POST', `/api/v1/sites/${dynamicSite}/content-backups`, b.cookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/sites/${dynamicSite}/content-backups`, b.cookie)).statusCode).toBe(404);
  });

  it('creates a content snapshot request for a dynamic site', async () => {
    const res = await call('POST', `/api/v1/sites/${dynamicSite}/content-backups`, a.cookie);
    expect(res.statusCode).toBe(202);
    const list = await call('GET', `/api/v1/sites/${dynamicSite}/content-backups`, a.cookie);
    const rows = list.json().data as { kind: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'content', status: 'pending' });
    // The whole-tree list must not mix content rows in.
    const tree = await call('GET', `/api/v1/sites/${dynamicSite}/backups`, a.cookie);
    expect(tree.json().data).toHaveLength(0);
    // A pending snapshot cannot be downloaded or restored yet.
    const backupId = (res.json().data as { backupId: string }).backupId;
    expect((await call('GET', `/api/v1/sites/${dynamicSite}/content-backups/${backupId}/download`, a.cookie)).statusCode).toBe(404);
  });

  it('validates uploaded content shape and the name confirmation', async () => {
    const bad = await call('POST', `/api/v1/sites/${dynamicSite}/content-backups/restore-upload`, a.cookie, { content: { site: {} }, confirm_name: 'Quan Dong A' });
    expect(bad.statusCode).toBe(422);
    const wrongName = await call('POST', `/api/v1/sites/${dynamicSite}/content-backups/restore-upload`, a.cookie, { content: VALID_CONTENT, confirm_name: 'Sai ten' });
    expect(wrongName.statusCode).toBe(422);
  });

  it('accepts a valid upload as a succeeded snapshot that downloads and restores', async () => {
    const up = await call('POST', `/api/v1/sites/${dynamicSite}/content-backups/restore-upload`, a.cookie, { content: VALID_CONTENT, confirm_name: 'Quan Dong A' });
    expect(up.statusCode).toBe(202);
    const backupId = (up.json().data as { backup_id: string }).backup_id;
    const download = await call('GET', `/api/v1/sites/${dynamicSite}/content-backups/${backupId}/download`, a.cookie);
    expect(download.statusCode).toBe(200);
    expect(JSON.parse(download.body)).toMatchObject({ site: { name: 'Quán Đông' } });
    const restore = await call('POST', `/api/v1/sites/${dynamicSite}/content-backups/${backupId}/restore`, a.cookie, { confirm_name: 'Quan Dong A' });
    expect(restore.statusCode).toBe(200);
    const dep = await ctx.db.query<{ operation: string; backup_id: string }>('SELECT operation, backup_id FROM deployments WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1', [dynamicSite]);
    expect(dep.rows[0]).toMatchObject({ operation: 'restore', backup_id: backupId });
  });
});
