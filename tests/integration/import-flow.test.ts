/**
 * Vertical slice M2: ZIP upload → import job → worker pipeline → isolated preview origin → draft catalog.
 * Covers AT-02, AT-03, AT-05, AT-06, AT-30, AT-32 and REQ-02/04/05/06/07 at the static-html level.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, httpGetWithHost, IMPORT_JOB_TYPE, REPO_ROOT } from '@3t/core';
import { buildZip, type RawZipEntry } from '@3t/template-sdk/testing';
import { createPreviewServer } from '@3t/preview';
import { runImportJob } from '@3t/worker/pipeline';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let previewPort: number;
let closePreview: () => Promise<void>;

beforeAll(async () => {
  ctx = await createTestContext();
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  previewPort = (server.address() as AddressInfo).port;
  ctx.config.previewInternalUrl = `http://127.0.0.1:${previewPort}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
});

afterAll(async () => {
  await closePreview();
  await ctx.close();
});

async function walk(dir: string, root = dir): Promise<RawZipEntry[]> {
  const out: RawZipEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ name: relative(root, full).split('\\').join('/'), data: await readFile(full), deflate: true });
  }
  return out;
}

async function fixtureZip(): Promise<Buffer> {
  return buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
}

const headers = () => ({ cookie: owner.cookie, origin: ORIGIN });

async function upload(zip: Buffer, filename = 'landing.zip', as = owner) {
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const session = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/imports/upload-sessions',
    headers: { cookie: as.cookie, origin: ORIGIN },
    payload: { filename, size_bytes: zip.length, sha256, rights_confirmed: true },
  });
  expect(session.statusCode, session.body).toBe(201);
  const { id, upload_url } = session.json().data;
  const put = await ctx.app.inject({ method: 'PUT', url: upload_url, headers: { cookie: as.cookie, origin: ORIGIN, 'content-type': 'application/zip' }, payload: zip });
  return { id: id as string, put };
}

async function startImport(zip: Buffer, filename?: string) {
  const { id, put } = await upload(zip, filename);
  expect(put.statusCode, put.body).toBe(200);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/imports',
    headers: { ...headers(), 'idempotency-key': randomUUID() },
    payload: { upload_session_id: id },
  });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().data as { job_id: string; resource_id: string; progress_url: string };
}

/** Run queued import jobs the way the worker process does. */
async function drainWorker() {
  for (;;) {
    const job = await claimJob(ctx.db, 'test-worker', [IMPORT_JOB_TYPE], 60);
    if (!job) return;
    await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
  }
}

async function getImport(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${id}`, headers: headers() });
  expect(res.statusCode).toBe(200);
  return { body: res.json().data, etag: res.headers.etag as string };
}

async function previewFetch(url: string, path: string) {
  const label = new URL(url).hostname.split('.')[0];
  const res = await httpGetWithHost(`http://127.0.0.1:${previewPort}`, `${label}.${ctx.config.previewBaseDomain}`, path);
  return { status: res.status, header: (name: string) => res.headers[name] as string | undefined, text: () => res.body.toString('utf8') };
}

describe('static HTML import (AT-02)', () => {
  let importId: string;

  it('imports the fixture, serves it on the preview origin and creates a draft', async () => {
    const started = await startImport(await fixtureZip());
    importId = started.resource_id;
    const job = await ctx.app.inject({ method: 'GET', url: started.progress_url, headers: headers() });
    expect(job.json().data).toMatchObject({ status: 'queued', resource: { type: 'import', id: importId } });
    await drainWorker();
    const { body } = await getImport(importId);
    expect(body.status, JSON.stringify(body.errors)).toBe('ready');
    expect(body).toMatchObject({ detected_adapter: 'static-html', confidence: 'declared', error_code: null });
    expect(body.effective_manifest).toMatchObject({ slug: 'landing-fixture', version: '1.0.0', projectRoot: 'site' });
    expect(body.steps.find((s: { step: string }) => s.step === 'build').status).toBe('skipped');
    expect(body.steps.find((s: { step: string }) => s.step === 'smoke').status).toBe('succeeded');
    expect(body.steps.find((s: { step: string }) => s.step === 'screenshots')).toMatchObject({ status: 'skipped', detail: { reason: 'screenshots_disabled' } });
    expect(body.preview.url).toMatch(/^http:\/\/[a-z2-7]{32}\.preview\.localhost:4100\/$/);
    expect(body.draft.version_id).toBeTruthy();

    const home = await previewFetch(body.preview.url, '/');
    expect(home.status).toBe(200);
    expect(home.text()).toContain('Landing page đã tải đúng tài nguyên.');
    expect(home.header('x-robots-tag')).toBe('noindex, nofollow');
    expect(home.header('content-security-policy')).toContain(`frame-ancestors 'self' ${ORIGIN}`);
    const css = await previewFetch(body.preview.url, '/style.css');
    expect(css.header('content-type')).toBe('text/css; charset=utf-8');
    expect((await previewFetch(body.preview.url, '/details.html')).status).toBe(200);
    expect((await previewFetch(body.preview.url, '/%2e%2e/template.manifest.json')).status).toBe(400);
    expect((await previewFetch(body.preview.url, '/missing.html')).status).toBe(404);
    expect((await httpGetWithHost(`http://127.0.0.1:${previewPort}`, 'localhost', '/')).status).toBe(404);
  });

  it('shows the draft in admin but not in the public catalog', async () => {
    const admin = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/templates', headers: headers() });
    expect(admin.json().data[0]).toMatchObject({
      slug: 'landing-fixture',
      status: 'draft',
      titles: { vi: 'Mẫu kiểm thử landing', en: 'Landing test fixture' },
      latest_version: { semver: '1.0.0', adapter: 'static-html', status: 'ready' },
    });
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates' });
    expect(pub.json().data).toEqual([]);
  });

  it('keeps the original source archive and an immutable version', async () => {
    const { rows } = await ctx.db.query<{ object_key: string }>("SELECT object_key FROM artifacts WHERE kind = 'source_archive'");
    expect(rows.length).toBeGreaterThan(0);
    expect(existsSync(ctx.store.pathFor(rows[0]!.object_key))).toBe(true);
    await expect(ctx.db.query("UPDATE template_versions SET source_sha = repeat('0', 64)")).rejects.toThrow(/immutable/);
    const logs = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${importId}/logs`, headers: headers() });
    expect(logs.json().data.map((l: { code: string }) => l.code)).toContain('smoke_ok');
  });

  it('reuses the version when identical content is re-imported, rejects same semver with different source (AT-30)', async () => {
    const again = await startImport(await fixtureZip(), 'landing-copy.zip');
    await drainWorker();
    const reused = await getImport(again.resource_id);
    expect(reused.body.status).toBe('ready');
    const entries = await walk(join(REPO_ROOT, 'examples/static-landing'));
    const changed = entries.map((e) => (e.name === 'site/index.html' ? { ...e, data: Buffer.from(String(e.data).replace('Landing page', 'Changed page')) } : e));
    const conflict = await startImport(buildZip(changed), 'landing-changed.zip');
    await drainWorker();
    const { body } = await getImport(conflict.resource_id);
    expect(body).toMatchObject({ status: 'rejected', error_code: 'version_conflict' });
    expect(body.errors).toEqual([{ pointer: '/version', code: 'semver_exists_with_different_source' }]);
  });
});

describe('hostile and unsupported packages', () => {
  it('rejects path traversal before writing anything (AT-03)', async () => {
    const started = await startImport(buildZip([{ name: 'index.html', data: '<h1>x</h1>' }, { name: '../../escape.html', data: 'x' }]));
    await drainWorker();
    const { body } = await getImport(started.resource_id);
    expect(body).toMatchObject({ status: 'rejected', error_code: 'archive_unsafe' });
    expect(body.errors).toEqual([{ reason: 'parent_segment', entry: '../../escape.html' }]);
    expect(existsSync(join(ctx.config.workDir, '..', 'escape.html'))).toBe(false);
    expect(existsSync(join(ctx.config.workDir, started.resource_id))).toBe(false);
  });

  it('rejects packages containing secrets without echoing values', async () => {
    const started = await startImport(buildZip([{ name: 'index.html', data: 'ok' }, { name: '.env', data: 'DB_PASSWORD=hunter2hunter2' }]));
    await drainWorker();
    const { body } = await getImport(started.resource_id);
    expect(body).toMatchObject({ status: 'rejected', error_code: 'secret_detected', errors: [{ path: '.env', rule: 'dotenv_file' }] });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('reports unsupported stacks instead of guessing (REQ-04)', async () => {
    const started = await startImport(buildZip([{ name: 'index.php', data: '<?php echo 1;' }]));
    await drainWorker();
    expect((await getImport(started.resource_id)).body).toMatchObject({ status: 'rejected', error_code: 'adapter_unsupported' });
  });

  it('does not deploy a Vite source tree as static output (AT-05)', async () => {
    const started = await startImport(
      buildZip([
        { name: 'index.html', data: '<div id=app></div>' },
        { name: 'package.json', data: JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '7.0.0' } }) },
      ]),
    );
    await drainWorker();
    const { body } = await getImport(started.resource_id);
    expect(body).toMatchObject({ status: 'needs_configuration', error_code: 'needs_configuration', detected_adapter: 'vite-static' });
    expect(body.missing_fields).toContain('/build/lockfile');
    expect(body.detection.adapter_implemented).toBe(false);
  });

  it('rejects a static site that ships executables', async () => {
    const started = await startImport(buildZip([{ name: 'index.html', data: '<h1>x</h1>' }, { name: 'setup.exe', data: 'MZ' }]));
    await drainWorker();
    expect((await getImport(started.resource_id)).body).toMatchObject({ status: 'rejected', error_code: 'policy_denied' });
  });
});

describe('configuration loop (A04, AT-06)', () => {
  it('asks for a project root when ambiguous, then succeeds after configuration', async () => {
    const started = await startImport(
      buildZip([
        { name: 'a/index.html', data: '<h1>A</h1>' },
        { name: 'b/index.html', data: '<h1>B</h1>' },
      ]),
      'Hai thư mục.zip',
    );
    await drainWorker();
    const first = await getImport(started.resource_id);
    expect(first.body).toMatchObject({ status: 'needs_configuration', missing_fields: ['/projectRoot'] });
    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/imports/${started.resource_id}/configuration`,
      headers: { ...headers(), 'if-match': '"1"' },
      payload: { projectRoot: 'b' },
    });
    expect(stale.statusCode).toBe(412);
    const forbiddenField = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/imports/${started.resource_id}/configuration`,
      headers: { ...headers(), 'if-match': first.etag },
      payload: { runtime: { start: ['sh', '-c', 'curl evil'] } },
    });
    expect(forbiddenField.statusCode).toBe(422);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/imports/${started.resource_id}/configuration`,
      headers: { ...headers(), 'if-match': first.etag },
      payload: { projectRoot: 'b', slug: 'hai-thu-muc', version: '0.1.0', name: { vi: 'Hai thư mục' } },
    });
    expect(patch.statusCode, patch.body).toBe(202);
    await drainWorker();
    const second = await getImport(started.resource_id);
    expect(second.body.status, JSON.stringify(second.body.errors)).toBe('ready');
    expect(second.body.configuration.revision).toBe(1);
    const home = await previewFetch(second.body.preview.url, '/');
    expect(home.text()).toContain('<h1>B</h1>');
  });

  it('returns JSON pointers for an invalid declared manifest', async () => {
    const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'examples/static-landing/template.manifest.json'), 'utf8'));
    manifest.schemaVersion = 2;
    manifest.slug = 'bad-manifest';
    const started = await startImport(buildZip([{ name: 'template.manifest.json', data: JSON.stringify(manifest) }, { name: 'site/index.html', data: 'x' }]));
    await drainWorker();
    const { body } = await getImport(started.resource_id);
    expect(body).toMatchObject({ status: 'needs_configuration', error_code: 'manifest_invalid' });
    expect(body.errors).toContainEqual(expect.objectContaining({ pointer: '/schemaVersion', code: 'unsupported_schema_version' }));
  });
});

describe('upload and API guards', () => {
  it('rejects checksum mismatch and non-zip content', async () => {
    const zip = await fixtureZip();
    const session = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports/upload-sessions',
      headers: headers(),
      payload: { filename: 'x.zip', size_bytes: zip.length, sha256: '0'.repeat(64), rights_confirmed: true },
    });
    const put = await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...headers(), 'content-type': 'application/zip' }, payload: zip });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.code).toBe('upload.checksum_mismatch');
    const notZip = Buffer.from('<html>definitely not a zip</html>');
    const { put: put2 } = await upload(notZip, 'fake.zip');
    expect(put2.json().error.code).toBe('upload.not_zip');
  });

  it('requires an Idempotency-Key and replays the same response for retries', async () => {
    const { id } = await upload(await fixtureZip(), 'idem.zip');
    const noKey = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: headers(), payload: { upload_session_id: id } });
    expect(noKey.statusCode).toBe(400);
    const key = randomUUID();
    const first = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...headers(), 'idempotency-key': key }, payload: { upload_session_id: id } });
    const second = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...headers(), 'idempotency-key': key }, payload: { upload_session_id: id } });
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      headers: { ...headers(), 'idempotency-key': key },
      payload: { upload_session_id: randomUUID() },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('idempotency.key_reused');
    await drainWorker();
  });

  it('enforces permissions at the API (AT-31)', async () => {
    const customer = await createUser(ctx, 'customer@example.com');
    const support = await createUser(ctx, 'support@example.com', 'support');
    for (const user of [customer, support]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/imports/upload-sessions',
        headers: { cookie: user.cookie, origin: ORIGIN },
        payload: { filename: 'x.zip', size_bytes: 10, sha256: 'a'.repeat(64), rights_confirmed: true },
      });
      expect(res.statusCode).toBe(403);
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/imports', headers: { cookie: customer.cookie } });
    expect(list.statusCode).toBe(403);
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/imports' });
    expect(anon.statusCode).toBe(401);
  });

  it('lets another staff member upload but not reuse someone else’s upload session', async () => {
    const editor = await createUser(ctx, 'editor@example.com', 'template_editor');
    const { id } = await upload(await fixtureZip(), 'mine.zip');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      headers: { cookie: editor.cookie, origin: ORIGIN, 'idempotency-key': randomUUID() },
      payload: { upload_session_id: id },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cancels a queued import and never runs it', async () => {
    const started = await startImport(await fixtureZip(), 'cancel.zip');
    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/imports/${started.resource_id}/cancel`, headers: headers() });
    expect(cancel.json().data.status).toBe('cancelled');
    await drainWorker();
    expect((await getImport(started.resource_id)).body.status).toBe('cancelled');
  });
});
