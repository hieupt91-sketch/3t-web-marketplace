import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptSecret, type Db, type JobRow, type LocalObjectStore, type PlatformConfig } from '@3t/core';
import { ArchiveError } from '@3t/template-sdk';
import { buildZip } from '@3t/template-sdk/testing';
import {
  SiteJobError,
  assertSiteUpdateAllowed,
  carrySiteData,
  extractBackupArchive,
  readSiteSetupToken,
  runSiteJob,
  runUpdate,
  siteUpdateFreeUntil,
  stripDemoCredentials,
} from './site-jobs.js';

/**
 * v44: an update swaps the site's whole tree for the new version artifact
 * (code + seed only). carrySiteData moves the customer's live data/ into
 * the staged tree first, so updating never resets their content,
 * bookings, site admin account, uploads or Google Sheet integration.
 */
describe('carrySiteData', () => {
  it('copies the whole data tree, including nested uploads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(join(live, 'data', 'uploads'), { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(live, 'data', 'content.json'), '{"edited":true}');
    await writeFile(join(live, 'data', 'bookings.json'), '[{"id":"b1"}]');
    await writeFile(join(live, 'data', 'admin.json'), '{"user":"admin"}');
    await writeFile(join(live, 'data', 'integrations.json'), '{"sheet":"https://script.google.com/x"}');
    await writeFile(join(live, 'data', 'uploads', 'a.txt'), 'upload-bytes');

    await carrySiteData(live, staged);

    await expect(readFile(join(staged, 'data', 'content.json'), 'utf8')).resolves.toBe('{"edited":true}');
    await expect(readFile(join(staged, 'data', 'bookings.json'), 'utf8')).resolves.toBe('[{"id":"b1"}]');
    await expect(readFile(join(staged, 'data', 'admin.json'), 'utf8')).resolves.toBe('{"user":"admin"}');
    await expect(readFile(join(staged, 'data', 'integrations.json'), 'utf8')).resolves.toBe('{"sheet":"https://script.google.com/x"}');
    await expect(readFile(join(staged, 'data', 'uploads', 'a.txt'), 'utf8')).resolves.toBe('upload-bytes');
  });

  it('customer data wins over any data/ the artifact ships', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(join(live, 'data'), { recursive: true });
    await mkdir(join(staged, 'data'), { recursive: true });
    await writeFile(join(live, 'data', 'content.json'), '{"mine":true}');
    await writeFile(join(staged, 'data', 'content.json'), '{"seed":true}');
    await writeFile(join(staged, 'data', 'seed-only.json'), '{}');

    await carrySiteData(live, staged);

    await expect(readFile(join(staged, 'data', 'content.json'), 'utf8')).resolves.toBe('{"mine":true}');
    expect(existsSync(join(staged, 'data', 'seed-only.json'))).toBe(false);
  });

  it('is a no-op when the live site has no data directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(live, { recursive: true });
    await mkdir(staged, { recursive: true });

    await carrySiteData(live, staged);

    expect(existsSync(join(staged, 'data'))).toBe(false);
  });
});

/**
 * Audit H-01: a promoted demo tree carries the demo admin account, whose
 * password is public (admin/Demo1234). stripDemoCredentials removes the
 * account, the session signing key and any stale setup token — so the
 * promoted site boots in first-run state — while the buyer's own demo
 * edits (content, bookings, uploads, integrations) survive untouched.
 */
describe('stripDemoCredentials', () => {
  it('removes credential artefacts but keeps the buyer\u2019s data', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-strip-'));
    const site = join(base, 'site');
    await mkdir(join(site, 'data', 'uploads'), { recursive: true });
    await writeFile(join(site, 'data', 'admin.json'), '{"username":"admin","salt":"s","hash":"h"}');
    await writeFile(join(site, 'data', 'session-key'), 'demo-session-key');
    await writeFile(join(site, 'data', 'setup-token.txt'), 'stale-token');
    await writeFile(join(site, 'data', 'content.json'), '{"edited":true}');
    await writeFile(join(site, 'data', 'bookings.json'), '[{"id":"b1"}]');
    await writeFile(join(site, 'data', 'integrations.json'), '{"sheet":"https://script.google.com/x"}');
    await writeFile(join(site, 'data', 'uploads', 'a.txt'), 'upload-bytes');

    await stripDemoCredentials(site);

    expect(existsSync(join(site, 'data', 'admin.json'))).toBe(false);
    expect(existsSync(join(site, 'data', 'session-key'))).toBe(false);
    expect(existsSync(join(site, 'data', 'setup-token.txt'))).toBe(false);
    await expect(readFile(join(site, 'data', 'content.json'), 'utf8')).resolves.toBe('{"edited":true}');
    await expect(readFile(join(site, 'data', 'bookings.json'), 'utf8')).resolves.toBe('[{"id":"b1"}]');
    await expect(readFile(join(site, 'data', 'integrations.json'), 'utf8')).resolves.toBe('{"sheet":"https://script.google.com/x"}');
    await expect(readFile(join(site, 'data', 'uploads', 'a.txt'), 'utf8')).resolves.toBe('upload-bytes');
  });

  it('is a no-op when the credential files are absent', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-strip-'));
    const site = join(base, 'site');
    await mkdir(join(site, 'data'), { recursive: true });
    await writeFile(join(site, 'data', 'content.json'), '{"seed":true}');

    await stripDemoCredentials(site);

    await expect(readFile(join(site, 'data', 'content.json'), 'utf8')).resolves.toBe('{"seed":true}');
  });
});

/**
 * Audit code L-02: restore must extract the backup through the verified
 * `extractArchive` (via extractBackupArchive), not the system `unzip`.
 * A crafted backup carrying a symlink entry or a `../` entry is rejected
 * during central-directory validation — before anything is written —
 * while a normal platform backup restores byte-for-byte.
 */
describe('extractBackupArchive (site restore)', () => {
  async function setupZip(entries: Parameters<typeof buildZip>[0]) {
    const dir = await mkdtemp(join(tmpdir(), 'mp-restore-'));
    const zip = join(dir, 'backup.zip');
    await writeFile(zip, buildZip(entries));
    const staged = join(dir, 'staged');
    await mkdir(staged, { recursive: true });
    return { dir, zip, staged };
  }

  it('restores a normal backup tree', async () => {
    const { zip, staged } = await setupZip([
      { name: 'index.html', data: '<h1>site</h1>' },
      { name: 'server.mjs', data: 'console.log("up")' },
      { name: 'data/content.json', data: '{"edited":true}' },
      { name: 'data/uploads/a.txt', data: 'upload-bytes' },
    ]);
    await extractBackupArchive(zip, staged);
    await expect(readFile(join(staged, 'index.html'), 'utf8')).resolves.toBe('<h1>site</h1>');
    await expect(readFile(join(staged, 'data', 'content.json'), 'utf8')).resolves.toBe('{"edited":true}');
    await expect(readFile(join(staged, 'data', 'uploads', 'a.txt'), 'utf8')).resolves.toBe('upload-bytes');
  });

  it('rejects a backup containing a symlink entry and writes nothing', async () => {
    const { dir, zip, staged } = await setupZip([
      { name: 'index.html', data: 'ok' },
      { name: 'evil-link', data: '/etc/passwd', mode: 0o120777 },
    ]);
    const error = await extractBackupArchive(zip, staged).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).issues.map((i) => i.reason)).toContain('symlink');
    expect(await readdir(staged)).toEqual([]);
    expect(existsSync(join(dir, 'evil-link'))).toBe(false);
  });

  it('rejects a backup containing a ../ entry and writes nothing outside staging', async () => {
    const { dir, zip, staged } = await setupZip([
      { name: 'index.html', data: 'ok' },
      { name: '../escape.txt', data: 'pwned' },
    ]);
    const error = await extractBackupArchive(zip, staged).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).issues.map((i) => i.reason)).toContain('parent_segment');
    expect(await readdir(staged)).toEqual([]);
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  });
});

/**
 * Audit payments L7: the API's 12-month gate is re-checked by the worker
 * before an update job touches the site. Fake Db answers only the
 * entitlement query (the gate's single read) plus deployment updates.
 */
function fakeEntitlementDb(freeUntil: Date | null, deploymentUpdates: string[] = []): Db {
  const query = async (sql: string) => {
    if (sql.includes('FROM entitlements')) {
      return { rows: freeUntil ? [{ free_until: freeUntil }] : [], rowCount: freeUntil ? 1 : 0 };
    }
    if (sql.includes('UPDATE deployments')) {
      deploymentUpdates.push(sql);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query in fake db: ${sql.slice(0, 80)}`);
  };
  return { query } as unknown as Db;
}

const DAY = 24 * 60 * 60 * 1000;

describe('site update window re-check (worker)', () => {
  it('siteUpdateFreeUntil returns null without an entitlement and never queries', async () => {
    const db = fakeEntitlementDb(new Date());
    await expect(siteUpdateFreeUntil(db, null)).resolves.toBeNull();
  });

  it('refuses an update whose 12-month window has expired', async () => {
    const db = fakeEntitlementDb(new Date(Date.now() - DAY));
    const error = await assertSiteUpdateAllowed(db, { entitlement_id: 'ent-1' }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(SiteJobError);
    expect((error as SiteJobError).code).toBe('site_update_window_expired');
  });

  it('allows an update still inside the window', async () => {
    const db = fakeEntitlementDb(new Date(Date.now() + 30 * DAY));
    await expect(assertSiteUpdateAllowed(db, { entitlement_id: 'ent-1' })).resolves.toBeUndefined();
  });

  it('allows a site with no entitlement (the API intentionally does not gate those)', async () => {
    const db = fakeEntitlementDb(new Date(Date.now() - DAY));
    await expect(assertSiteUpdateAllowed(db, { entitlement_id: null })).resolves.toBeUndefined();
  });

  it('runUpdate refuses an expired-window job before touching the site files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-update-gate-'));
    const workDir = join(base, 'work');
    const siteId = 'site-1';
    const siteDirPath = join(workDir, 'sites', siteId);
    await mkdir(join(siteDirPath, 'data'), { recursive: true });
    await writeFile(join(siteDirPath, 'data', 'content.json'), '{"mine":true}');
    await writeFile(join(siteDirPath, 'server.mjs'), 'original');
    const deploymentUpdates: string[] = [];
    const db = fakeEntitlementDb(new Date(Date.now() - DAY), deploymentUpdates);
    const site = {
      id: siteId, owner_id: 'owner-1', entitlement_id: 'ent-1', template_version_id: 'v1',
      display_name: 'Site', subdomain: 'site-1', default_locale: 'vi', status: 'active',
      demo_session_id: null, runtime_kind: 'runtime', runtime_port: null, runtime_pid: null, runtime_uid: null,
      // Phase 1: SiteRow gained the runner fencing version (SELECT * always returned it).
      row_version: 1,
    };
    const job = { id: 'job-1', type: 'site.update', payload_json: { site_id: siteId } } as unknown as JobRow;
    const config = { workDir } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    const error = await runUpdate({ config, db, store }, job, site, 'v2', 'dep-1').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(SiteJobError);
    expect((error as SiteJobError).code).toBe('site_update_window_expired');
    // The refusal is recorded on the deployment with its own error code…
    expect(deploymentUpdates.some((sql) => sql.includes("error_code = 'site_update_window_expired'"))).toBe(true);
    // …and the site tree is byte-identical, with no staging dir created.
    await expect(readFile(join(siteDirPath, 'server.mjs'), 'utf8')).resolves.toBe('original');
    await expect(readFile(join(siteDirPath, 'data', 'content.json'), 'utf8')).resolves.toBe('{"mine":true}');
    expect(existsSync(join(workDir, 'tmp'))).toBe(false);
  });
});

/**
 * H2 gating fixes 1+2: the admin-setup token read and the hosting
 * purge moved from the (soon non-root) API into the worker. The fake
 * Db answers the site load and captures every UPDATE so the tests can
 * assert exactly what the job published / marked — and, for a failed
 * purge, what it must NEVER mark.
 */
interface CapturedUpdate {
  sql: string;
  params: unknown[];
}

function fakeSiteJobDb(siteRow: Record<string, unknown>, captured: CapturedUpdate[]): Db {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM sites')) return { rows: [siteRow], rowCount: 1 };
    if (sql.startsWith('UPDATE jobs') || sql.startsWith('UPDATE sites')) {
      captured.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query in fake db: ${sql.slice(0, 80)}`);
  };
  return { query } as unknown as Db;
}

function makeRunningJob(type: string, siteId: string): JobRow {
  return {
    id: 'job-1', type, payload_json: { site_id: siteId }, dedupe_key: 'k', resource_type: 'site',
    resource_id: siteId, owner_id: 'owner-1', status: 'running', attempts: 1, max_attempts: 1,
    fencing_token: '7', lease_until: null, step: null, completed_steps: 0, total_steps: null,
    last_error_code: null, result_json: null, created_at: new Date(), updated_at: new Date(),
  } as unknown as JobRow;
}

const SETUP_KEY = 'test-partner-webhook-key';

function siteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'site-1', owner_id: 'owner-1', entitlement_id: null, template_version_id: 'v1',
    display_name: 'Site', subdomain: 'site-1', default_locale: 'vi', status: 'active',
    demo_session_id: null, runtime_kind: 'runtime', runtime_port: null, runtime_pid: null, runtime_uid: 20001,
    ...overrides,
  };
}

describe('site.setup-token job (H2 fix 1)', () => {
  it('reads and trims the token file; missing or empty means not pending', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-setup-token-'));
    const config = { workDir } as unknown as PlatformConfig;
    await expect(readSiteSetupToken(config, 'site-1')).resolves.toBeNull();
    const dataDir = join(workDir, 'sites', 'site-1', 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'setup-token.txt'), '  tok-abc\n', 'utf8');
    await expect(readSiteSetupToken(config, 'site-1')).resolves.toBe('tok-abc');
    await writeFile(join(dataDir, 'setup-token.txt'), '   \n', 'utf8');
    await expect(readSiteSetupToken(config, 'site-1')).resolves.toBeNull();
  });

  it('publishes the token SEALED in the job result, never in plaintext', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-setup-token-'));
    const dataDir = join(workDir, 'sites', 'site-1', 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'setup-token.txt'), 'tok-secret-xyz', 'utf8');
    const captured: CapturedUpdate[] = [];
    const db = fakeSiteJobDb(siteRow(), captured);
    const config = { workDir, partnerWebhookKey: SETUP_KEY } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    await runSiteJob({ config, db, store }, makeRunningJob('site.setup-token', 'site-1'));

    const published = captured.find((u) => u.sql.includes('SET result_json'));
    expect(published).toBeTruthy();
    const result = JSON.parse(published!.params[2] as string) as { token_enc: string | null };
    expect(result.token_enc).toBeTruthy();
    expect(result.token_enc).not.toContain('tok-secret-xyz');
    expect(decryptSecret(SETUP_KEY, result.token_enc!)).toBe('tok-secret-xyz');
    // And the job completed normally afterwards.
    expect(captured.some((u) => u.sql.includes("status = 'succeeded'"))).toBe(true);
  });

  it('publishes token_enc null when setup is not pending', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-setup-token-'));
    const captured: CapturedUpdate[] = [];
    const db = fakeSiteJobDb(siteRow(), captured);
    const config = { workDir, partnerWebhookKey: SETUP_KEY } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    await runSiteJob({ config, db, store }, makeRunningJob('site.setup-token', 'site-1'));

    const published = captured.find((u) => u.sql.includes('SET result_json'));
    expect(JSON.parse(published!.params[2] as string)).toEqual({ token_enc: null });
  });
});

describe('site.purge job (H2 fix 2)', () => {
  it('deletes the tree, releases the UID, and only then marks the site purged', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-purge-'));
    const tree = join(workDir, 'sites', 'site-1');
    await mkdir(join(tree, 'data'), { recursive: true });
    await writeFile(join(tree, 'server.mjs'), 'code');
    await writeFile(join(tree, 'data', 'content.json'), '{}');
    const captured: CapturedUpdate[] = [];
    const db = fakeSiteJobDb(siteRow({ status: 'delete_scheduled' }), captured);
    const config = { workDir } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    await runSiteJob({ config, db, store }, makeRunningJob('site.purge', 'site-1'));

    expect(existsSync(tree)).toBe(false);
    expect(captured.some((u) => u.sql.includes('SET runtime_uid = NULL'))).toBe(true);
    expect(captured.some((u) => u.sql.includes("status = 'purged'"))).toBe(true);
    expect(captured.some((u) => u.sql.includes("status = 'succeeded'"))).toBe(true);
    // The purge update happens strictly after the UID release.
    const releaseIdx = captured.findIndex((u) => u.sql.includes('SET runtime_uid = NULL'));
    const purgeIdx = captured.findIndex((u) => u.sql.includes("status = 'purged'"));
    expect(purgeIdx).toBeGreaterThan(releaseIdx);
  });

  it('a failed delete fails the job with site_purge_failed and never marks the site purged', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-purge-fail-'));
    // `sites` as a regular file makes the tree path undeletable (ENOTDIR).
    await writeFile(join(workDir, 'sites'), 'not a directory', 'utf8');
    const captured: CapturedUpdate[] = [];
    const db = fakeSiteJobDb(siteRow({ status: 'delete_scheduled' }), captured);
    const config = { workDir } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    await runSiteJob({ config, db, store }, makeRunningJob('site.purge', 'site-1'));

    const failure = captured.find((u) => u.sql.includes('SET status = $3'));
    expect(failure).toBeTruthy();
    expect(failure!.params[2]).toBe('failed');
    expect(failure!.params[3]).toBe('site_purge_failed');
    expect(captured.some((u) => u.sql.includes("status = 'purged'"))).toBe(false);
    expect(captured.some((u) => u.sql.includes('SET runtime_uid = NULL'))).toBe(false);
  });

  it('is idempotent for an already-purged site (no filesystem or row writes)', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'mp-purge-again-'));
    const captured: CapturedUpdate[] = [];
    const db = fakeSiteJobDb(siteRow({ status: 'purged' }), captured);
    const config = { workDir } as unknown as PlatformConfig;
    const store = {} as unknown as LocalObjectStore;

    await runSiteJob({ config, db, store }, makeRunningJob('site.purge', 'site-1'));

    expect(captured.some((u) => u.sql.startsWith('UPDATE sites'))).toBe(false);
    expect(captured.some((u) => u.sql.includes("status = 'succeeded'"))).toBe(true);
  });
});
