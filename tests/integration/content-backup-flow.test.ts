import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob } from '@3t/core';
import { runSiteJob } from '@3t/worker/site-jobs';
import { createTestContext, createUser, ORIGIN, type TestContext } from '../../apps/api/src/test-helpers.ts';

/** Docs/12 content backups, executed end to end: the API enqueues
 *  site.content-backup / site.content-restore and the worker applies
 *  them to the site's data/content.json — the dynamic family's own
 *  backup unit — keeping the previous file as content.json.bak on
 *  restore, exactly like the template's built-in restore. */
let ctx: TestContext;
let owner: { id: string; cookie: string };
let siteId = '';
let siteDir = '';

const CONTENT_V1 = {
  site: { name: 'Quán Một' }, hero: {}, menu: { items: [{ name: 'A' }] }, spaces: { items: [] },
  reviews: { items: [] }, faqs: { items: [] }, bookingSteps: {}, bookingForm: {}, nav: {}, theme: {}, footer: {},
};
const CONTENT_V2 = { ...CONTENT_V1, site: { name: 'Quán Hai' }, menu: { items: [{ name: 'B' }] } };

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload: payload as object | undefined });

async function runNextJob(type: string): Promise<void> {
  const job = await claimJob(ctx.db, 'content-test-worker', [type], 60);
  if (!job) throw new Error(`no ${type} job to run`);
  await runSiteJob({ config: ctx.config, db: ctx.db, store: ctx.store }, job);
}

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await createUser(ctx, 'content-owner@example.com');
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('content-flow', $1, 'published') RETURNING id",
    [owner.id],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/content-flow.zip', $1, 10, 'application/zip', 'runtime_bundle', 'permanent') RETURNING id`,
    ['1'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"node-http","capabilities":["landing","admin"],"locales":{"supported":["vi"]},"export":{"modes":["hosted"]}}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [template.rows[0]!.id, '2'.repeat(64), artifact.rows[0]!.id],
  );
  const site = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, 'Quan Mot', 'content-flow', 'active') RETURNING id",
    [owner.id, version.rows[0]!.id],
  );
  siteId = site.rows[0]!.id;
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [siteId, owner.id]);
  siteDir = join(ctx.config.workDir, 'sites', siteId);
  await mkdir(join(siteDir, 'data'), { recursive: true });
  await writeFile(join(siteDir, 'data', 'content.json'), JSON.stringify(CONTENT_V1, null, 2));
  const stepUp = await call('POST', '/api/v1/auth/step-up', { password: 'correct horse battery staple' });
  if (stepUp.statusCode !== 200) throw new Error(`step-up failed ${stepUp.statusCode}`);
});
afterAll(async () => ctx.close());

describe('dynamic content backup round-trip', () => {
  it('snapshots content.json, then restoring it rolls back an edit and keeps a .bak', async () => {
    const created = await call('POST', `/api/v1/sites/${siteId}/content-backups`);
    expect(created.statusCode).toBe(202);
    const backupId = (created.json().data as { backupId: string }).backupId;
    await runNextJob('site.content-backup');
    const snap = await ctx.db.query<{ status: string; checksum: string | null }>('SELECT status, checksum FROM backups WHERE id = $1', [backupId]);
    expect(snap.rows[0]).toMatchObject({ status: 'succeeded' });
    expect(snap.rows[0]!.checksum).toBeTruthy();

    // The owner edits content in the site admin (file changes on disk).
    await writeFile(join(siteDir, 'data', 'content.json'), JSON.stringify(CONTENT_V2, null, 2));

    const restore = await call('POST', `/api/v1/sites/${siteId}/content-backups/${backupId}/restore`, { confirm_name: 'Quan Mot' });
    expect(restore.statusCode).toBe(200);
    await runNextJob('site.content-restore');

    const restored = JSON.parse(await readFile(join(siteDir, 'data', 'content.json'), 'utf8')) as typeof CONTENT_V1;
    expect(restored.site.name).toBe('Quán Một');
    const bak = JSON.parse(await readFile(join(siteDir, 'data', 'content.json.bak'), 'utf8')) as typeof CONTENT_V2;
    expect(bak.site.name).toBe('Quán Hai');
    const dep = await ctx.db.query<{ status: string }>('SELECT status FROM deployments WHERE backup_id = $1', [backupId]);
    expect(dep.rows[0]!.status).toBe('succeeded');
  });
});
