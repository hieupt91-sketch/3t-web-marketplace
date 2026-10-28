/**
 * M2 close: GitHub import (REQ-03, AT-04/AT-57) and demo sessions (D02–D04).
 * GitHub is faked with a local HTTP server: no real GitHub calls, no tokens.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, IMPORT_JOB_TYPE, REPO_ROOT } from '@3t/core';
import { buildZip, type RawZipEntry } from '@3t/template-sdk/testing';
import { createPreviewServer } from '@3t/preview';
import { runImportJob } from '@3t/worker/pipeline';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';
const WEBHOOK_SECRET = 'whsec-test';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let closePreview: () => Promise<void>;
let fake: Server;
let fakeBase = '';

async function walk(dir: string, root = dir): Promise<RawZipEntry[]> {
  const out: RawZipEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else out.push({ name: relative(root, full).split('\\').join('/'), data: await readFile(full), deflate: true });
  }
  return out;
}

async function drainWorker() {
  for (;;) {
    const job = await claimJob(ctx.db, 'w', [IMPORT_JOB_TYPE], 60);
    if (!job) return;
    await runImportJob({ config: ctx.config, db: ctx.db, store: ctx.store, screenshotter: null }, job);
  }
}

beforeAll(async () => {
  // Build a tarball of the static fixture, top dir `acme-shop-<sha>/`.
  const tmp = await mkdtemp(join(tmpdir(), 'mp-gh-'));
  const top = join(tmp, `acme-shop-${SHA1}`);
  execSync(`cp -r ${join(REPO_ROOT, 'examples/static-landing')} ${top}`);
  execSync(`tar -czf ${join(tmp, 'repo.tgz')} -C ${tmp} acme-shop-${SHA1}`);
  const tarball = await readFile(join(tmp, 'repo.tgz'));
  fake = createServer((req, res) => {
    if (req.url === '/repos/acme/shop') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ default_branch: 'main' }));
    } else if (req.url === '/repos/acme/shop/commits/main') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: SHA1 }));
    } else if (req.url === `/repos/acme/shop/commits/${SHA2}`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: SHA2 }));
    } else if (req.url === `/repos/acme/shop/tarball/${SHA1}` || req.url === `/repos/acme/shop/tarball/${SHA2}`) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tarball);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  ctx = await createTestContext({ githubApiBaseUrl: fakeBase, githubWebhookSecret: WEBHOOK_SECRET });
  const server = createPreviewServer({ config: ctx.config, db: ctx.db, store: ctx.store, cacheMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.config.previewInternalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closePreview = () => new Promise((resolve) => server.close(() => resolve()));
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
});

afterAll(async () => {
  await closePreview();
  await new Promise((resolve) => fake.close(() => resolve(undefined)));
  await ctx.close();
});

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });

describe('GitHub import', () => {
  it('pins the default-branch commit, imports the tarball, and dedupes webhook deliveries', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/imports/github',
      headers: { ...admin(), 'idempotency-key': randomUUID() },
      payload: { repo: 'acme/shop', rights_confirmed: true },
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json().data.commit_sha).toBe(SHA1);
    await drainWorker();
    const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
    expect(imp.json().data.status, JSON.stringify(imp.json().data)).toBe('ready');
    expect(imp.json().data.source_kind).toBe('github');
    expect(imp.json().data.commit_sha).toBe(SHA1);

    const sign = (body: unknown) => `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex')}`;
    const pushBody = { repository: { full_name: 'acme/shop' }, head_commit: { id: SHA2 }, ref: 'refs/heads/main' };
    const hook = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/imports/github-webhook',
      headers: { 'x-hub-signature-256': sign(pushBody), 'x-github-delivery': 'deliv-1', 'x-github-event': 'push', origin: ORIGIN, 'content-type': 'application/json' },
      payload: pushBody,
    });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(hook.json().outcome).toBe('processed');
    await drainWorker();
    const second = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${hook.json().import_id}`, headers: admin() });
    expect(second.json().data.status, JSON.stringify(second.json().data)).toBe('ready');
    expect(second.json().data.commit_sha).toBe(SHA2);

    const dup = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/imports/github-webhook',
      headers: { 'x-hub-signature-256': sign(pushBody), 'x-github-delivery': 'deliv-1', 'x-github-event': 'push', origin: ORIGIN, 'content-type': 'application/json' },
      payload: pushBody,
    });
    expect(dup.json().outcome).toBe('duplicate');
    const bad = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/imports/github-webhook',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-delivery': 'deliv-2', 'x-github-event': 'push', origin: ORIGIN, 'content-type': 'application/json' },
      payload: pushBody,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects an invalid repo name without calling GitHub', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/admin/imports/github',
      headers: { ...admin(), 'idempotency-key': randomUUID() },
      payload: { repo: 'not a repo', rights_confirmed: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('demo sessions', () => {
  it('creates a static session, blocks admin launch, and cancels (D02–D04)', async () => {
    const zip = buildZip(await walk(join(REPO_ROOT, 'examples/static-landing')));
    const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'fixture.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
    await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
    await drainWorker();
    const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
    const versionId = imp.json().data.draft.version_id as string;

    const demo = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo-sessions', headers: { origin: ORIGIN }, payload: { version_id: versionId } });
    expect(demo.statusCode, demo.body).toBe(201);
    expect(demo.json().data.url).toContain(ctx.config.previewBaseDomain);
    const get = await ctx.app.inject({ method: 'GET', url: `/api/v1/demo-sessions/${demo.json().data.id}`, headers: { origin: ORIGIN } });
    expect(get.json().data.status).toBe('active');
    const adminLaunch = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${demo.json().data.id}/admin-launch`, headers: { origin: ORIGIN } });
    expect(adminLaunch.statusCode).toBe(409);
    const cancel = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${demo.json().data.id}/cancel`, headers: { origin: ORIGIN } });
    expect(cancel.json().data.status).toBe('cancelled');
    const after = await ctx.app.inject({ method: 'GET', url: `/api/v1/demo-sessions/${demo.json().data.id}`, headers: { origin: ORIGIN } });
    expect(after.json().data.status).toBe('cancelled');
    expect(after.json().data.url).toBeNull();
  });

  it('spawns a runtime isolated-admin session with admin launch and reset', async () => {
    const zip = buildZip(await walk(join(REPO_ROOT, 'examples/node-service')));
    const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'fixture.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
    await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
    await drainWorker();
    const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
    const versionId = imp.json().data.draft.version_id as string;

    const demo = await ctx.app.inject({ method: 'POST', url: '/api/v1/demo-sessions', headers: { origin: ORIGIN }, payload: { version_id: versionId } });
    expect(demo.statusCode, demo.body).toBe(201);
    const demoId = demo.json().data.id as string;
    const url = demo.json().data.url as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const home = await fetch(url);
    expect(home.status).toBe(200);
    const launch = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${demoId}/admin-launch`, headers: { origin: ORIGIN } });
    expect(launch.statusCode, launch.body).toBe(201);
    expect(launch.json().data.admin_url).toContain('/admin');
    const reset = await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${demoId}/reset`, headers: { origin: ORIGIN } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().data.status).toBe('active');
    const home2 = await fetch(reset.json().data.url as string);
    expect(home2.status).toBe(200);
    // Clean up the spawned server so the test process can exit.
    await ctx.app.inject({ method: 'POST', url: `/api/v1/demo-sessions/${demoId}/cancel`, headers: { origin: ORIGIN } });
  });
});
