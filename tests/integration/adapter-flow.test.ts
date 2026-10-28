/**
 * M2 close: vite-static + node-http adapters (AT-05/AT-07/AT-09) and checkpoint resume.
 * Fixtures use script-driven builds (no real Vite download) under the same
 * manifest build/outputDir/start/healthPath contract the adapters implement.
 */
import { createHash, randomUUID } from 'node:crypto';
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
let closePreview: () => Promise<void>;
let previewPort = 0;

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

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });

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
async function importFixture(dir: string): Promise<{ importId: string; templateId: string; versionId: string }> {
  const zip = buildZip(await walk(join(REPO_ROOT, dir)));
  const session = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports/upload-sessions', headers: admin(), payload: { filename: 'fixture.zip', size_bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), rights_confirmed: true } });
  expect(session.statusCode, session.body).toBe(201);
  await ctx.app.inject({ method: 'PUT', url: session.json().data.upload_url, headers: { ...admin(), 'content-type': 'application/zip' }, payload: zip });
  const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/imports', headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: { upload_session_id: session.json().data.id } });
  expect(created.statusCode, created.body).toBe(202);
  await drainWorker();
  const imp = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${created.json().data.resource_id}`, headers: admin() });
  expect(imp.json().data.status, JSON.stringify(imp.json().data)).toBe('ready');
  return { importId: created.json().data.resource_id as string, templateId: imp.json().data.draft.template_id as string, versionId: imp.json().data.draft.version_id as string };
}

describe('vite-static adapter', () => {
  it('builds with the manifest script and serves the output on the preview origin', async () => {
    const { importId, versionId } = await importFixture('examples/vite-landing');
    const version = await ctx.db.query<{ adapter: string; artifact_id: string }>('SELECT adapter, artifact_id FROM template_versions WHERE id = $1', [versionId]);
    expect(version.rows[0]!.adapter).toBe('vite-static');
    const artifact = await ctx.db.query<{ kind: string; object_key: string }>('SELECT kind, object_key FROM artifacts WHERE id = $1', [version.rows[0]!.artifact_id]);
    expect(artifact.rows[0]!.kind).toBe('static_site');
    const preview = await ctx.db.query<{ host_label: string }>("SELECT host_label FROM previews WHERE import_id = $1 AND status = 'active'", [importId]);
    expect(preview.rows[0]).toBeDefined();
    const res = await httpGetWithHost(ctx.config.previewInternalUrl, `${preview.rows[0]!.host_label}.${ctx.config.previewBaseDomain}`, '/');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('Built by vite-static fixture');
  });
});

describe('node-http adapter', () => {
  it('builds, smoke-tests a spawned server, and records a runtime bundle', async () => {
    const { versionId } = await importFixture('examples/node-service');
    const version = await ctx.db.query<{ adapter: string; artifact_id: string }>('SELECT adapter, artifact_id FROM template_versions WHERE id = $1', [versionId]);
    expect(version.rows[0]!.adapter).toBe('node-http');
    const artifact = await ctx.db.query<{ kind: string }>('SELECT kind FROM artifacts WHERE id = $1', [version.rows[0]!.artifact_id]);
    expect(artifact.rows[0]!.kind).toBe('runtime_bundle');
  });
});

describe('next-standalone adapter', () => {
  it('copies the standalone server, smoke-tests it, and records a runtime bundle', async () => {
    const { versionId } = await importFixture('examples/next-standalone');
    const version = await ctx.db.query<{ adapter: string; artifact_id: string }>('SELECT adapter, artifact_id FROM template_versions WHERE id = $1', [versionId]);
    expect(version.rows[0]!.adapter).toBe('next-standalone');
    const artifact = await ctx.db.query<{ kind: string }>('SELECT kind FROM artifacts WHERE id = $1', [version.rows[0]!.artifact_id]);
    expect(artifact.rows[0]!.kind).toBe('runtime_bundle');
  });
});

describe('checkpoint resume', () => {
  it('reuses the recorded version and build run instead of rebuilding (M2 retry)', async () => {
    const { importId, templateId, versionId } = await importFixture('examples/static-landing');
    const before = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM build_runs WHERE import_id = $1', [importId]);
    expect(before.rows[0]!.n).toBe('1');
    // Forge a retry state: the run failed after `record`, with a checkpoint at `record`.
    const imp = await ctx.db.query<{ digest: string; effective_manifest_json: { manifest: Record<string, unknown> }; detection_json: Record<string, unknown> }>(
      'SELECT digest, effective_manifest_json, detection_json FROM imports WHERE id = $1', [importId]);
    const ver = await ctx.db.query<{ source_sha: string; artifact_id: string }>('SELECT source_sha, artifact_id FROM template_versions WHERE id = $1', [versionId]);
    const checkpoint = {
      step: 'record',
      sourceArchiveDigest: imp.rows[0]!.digest,
      configRevision: 0,
      detection: imp.rows[0]!.detection_json,
      manifest: imp.rows[0]!.effective_manifest_json.manifest,
      siteFiles: ['index.html'],
      entryAssets: [],
      htmlFiles: ['index.html'],
      sourceDigest: ver.rows[0]!.source_sha,
      siteArtifactId: ver.rows[0]!.artifact_id,
      versionId,
      templateId,
    };
    await ctx.db.query(
      `UPDATE imports SET status = 'failed', error_code = 'smoke_failed', checkpoint_json = $2 WHERE id = $1`,
      [importId, checkpoint],
    );
    await ctx.db.query(
      `UPDATE import_steps SET status = 'succeeded', attempt = 1 WHERE import_id = $1 AND step IN ('build', 'record')`,
      [importId],
    );
    await ctx.db.query(
      `UPDATE import_steps SET status = 'pending' WHERE import_id = $1 AND step IN ('provision_preview', 'init_db', 'health', 'smoke', 'screenshots', 'ready')`,
      [importId],
    );
    const retry = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/imports/${importId}/retry`, headers: { ...admin(), 'idempotency-key': randomUUID() }, payload: {} });
    expect(retry.statusCode, retry.body).toBe(202);
    await drainWorker();
    const after = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/imports/${importId}`, headers: admin() });
    expect(after.json().data.status).toBe('ready');
    const runs = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM build_runs WHERE import_id = $1', [importId]);
    expect(runs.rows[0]!.n).toBe('1'); // record was resumed, not re-run
    const versions = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM template_versions WHERE template_id = $1', [templateId]);
    expect(versions.rows[0]!.n).toBe('1');
    const buildAttempt = await ctx.db.query<{ attempt: number }>("SELECT attempt FROM import_steps WHERE import_id = $1 AND step = 'build'", [importId]);
    expect(buildAttempt.rows[0]!.attempt).toBe(1); // build step was not re-executed
  });
});
