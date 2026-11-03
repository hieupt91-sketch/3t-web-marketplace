import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob } from '@3t/core';
import { runSiteJob } from '@3t/worker/site-jobs';
import { createTestContext, createUser, ORIGIN, type TestContext } from '../../apps/api/src/test-helpers.ts';

/**
 * Owner delete-request must stop the site process (root-cause fix):
 * the API flips the site to delete_scheduled WITH a row_version bump
 * and enqueues the worker's fenced site.stop job — the same path admin
 * suspend uses. Before the fix the status flip stood alone and the
 * process kept running until purge (up to 30 days). Cancel-delete must
 * restore the site: if the stop already landed it enqueues a revive
 * restart (admin-resume shape); if the process never died, the pending
 * stop must no-op on the restored status.
 */
let ctx: TestContext;
let owner: { id: string; cookie: string };
let versionId = '';
const sleepers: ChildProcess[] = [];

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { origin: ORIGIN, cookie: owner.cookie }, payload: payload as object | undefined });

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  child.unref();
  sleepers.push(child);
  return child;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidAlive(pid);
}

async function makeSite(subdomain: string, status = 'active'): Promise<string> {
  const site = await ctx.db.query<{ id: string }>(
    'INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [owner.id, versionId, `Site ${subdomain}`, subdomain, status],
  );
  const id = site.rows[0]!.id;
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [id, owner.id]);
  return id;
}

async function siteRow(id: string) {
  const { rows } = await ctx.db.query<{ status: string; row_version: number; runtime_pid: number | null; runtime_port: number | null; purge_at: Date | null; previous_status: string | null }>(
    'SELECT status, row_version, runtime_pid, runtime_port, purge_at, previous_status FROM sites WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

async function jobsFor(id: string, type: string) {
  const { rows } = await ctx.db.query<{ dedupe_key: string; payload_json: { site_id?: string; row_version?: number; revive?: boolean }; status: string }>(
    'SELECT dedupe_key, payload_json, status FROM jobs WHERE resource_id = $1 AND type = $2 ORDER BY created_at',
    [id, type],
  );
  return rows;
}

async function runNextStopJob(expectedSiteId: string): Promise<void> {
  const job = await claimJob(ctx.db, 'delete-stop-test-worker', ['site.stop'], 60);
  if (!job) throw new Error('no site.stop job to run');
  expect((job.payload_json as { site_id?: string }).site_id).toBe(expectedSiteId);
  await runSiteJob({ config: ctx.config, db: ctx.db, store: ctx.store }, job);
}

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await createUser(ctx, 'delete-stop-owner@example.com');
  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('delete-stop-flow', $1, 'published') RETURNING id",
    [owner.id],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/delete-stop-flow.zip', $1, 10, 'application/zip', 'runtime_bundle', 'permanent') RETURNING id`,
    ['3'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"node-http","capabilities":["landing","admin"],"locales":{"supported":["vi"]},"export":{"modes":["hosted"]}}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [template.rows[0]!.id, '4'.repeat(64), artifact.rows[0]!.id],
  );
  versionId = version.rows[0]!.id;
  const stepUp = await call('POST', '/api/v1/auth/step-up', { password: 'correct horse battery staple' });
  if (stepUp.statusCode !== 200) throw new Error(`step-up failed ${stepUp.statusCode}`);
});
afterAll(async () => {
  for (const child of sleepers) child.kill('SIGKILL');
  await ctx.close();
});

describe('owner delete-request stops the site process', () => {
  it('enqueues a fenced site.stop that kills the process; cancel-delete then enqueues a revive restart', async () => {
    const siteId = await makeSite('delstop-a');
    const sleeper = spawnSleeper();
    await ctx.db.query('UPDATE sites SET runtime_pid = $2, runtime_port = 4191 WHERE id = $1', [siteId, sleeper.pid]);
    const before = await siteRow(siteId);

    const del = await call('POST', `/api/v1/sites/${siteId}/delete-request`);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().data.status).toBe('delete_scheduled');

    const after = await siteRow(siteId);
    expect(after.status).toBe('delete_scheduled');
    expect(after.previous_status).toBe('active');
    expect(after.row_version).toBe(before.row_version + 1);
    expect(after.purge_at).not.toBeNull();

    const stops = await jobsFor(siteId, 'site.stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.dedupe_key).toBe(`site.stop:${siteId}:${after.row_version}`);
    expect(stops[0]!.payload_json.row_version).toBe(after.row_version);

    // The worker stop lands: the real process dies and the runtime
    // fields are cleared, while the row stays delete_scheduled.
    await runNextStopJob(siteId);
    expect(await waitForDeath(sleeper.pid!, 5000)).toBe(true);
    const stopped = await siteRow(siteId);
    expect(stopped.status).toBe('delete_scheduled');
    expect(stopped.runtime_pid).toBeNull();
    expect(stopped.runtime_port).toBeNull();

    // Cancel-delete: the process is gone, so the restore must enqueue
    // a revive restart (admin-resume shape) to bring the site back.
    const cancel = await call('POST', `/api/v1/sites/${siteId}/cancel-delete`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await siteRow(siteId)).status).toBe('active');
    const restarts = await jobsFor(siteId, 'site.restart');
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.payload_json.revive).toBe(true);
  });

  it('cancel-delete before the stop lands enqueues no restart, and the pending stop no-ops on the restored site', async () => {
    const siteId = await makeSite('delstop-b');
    const sleeper = spawnSleeper();
    await ctx.db.query('UPDATE sites SET runtime_pid = $2, runtime_port = 4192 WHERE id = $1', [siteId, sleeper.pid]);

    const del = await call('POST', `/api/v1/sites/${siteId}/delete-request`);
    expect(del.statusCode, del.body).toBe(200);

    const cancel = await call('POST', `/api/v1/sites/${siteId}/cancel-delete`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await siteRow(siteId)).status).toBe('active');
    // Process never died → no revive restart is needed or wanted.
    expect(await jobsFor(siteId, 'site.restart')).toHaveLength(0);

    // The still-queued stop job is fenced out by the restored status:
    // running it must leave the live process and its fields untouched.
    await runNextStopJob(siteId);
    expect(pidAlive(sleeper.pid!)).toBe(true);
    const row = await siteRow(siteId);
    expect(row.runtime_pid).toBe(sleeper.pid!);
    expect(row.status).toBe('active');
  });

  it('cancel-delete back to suspended never enqueues a revive restart', async () => {
    const siteId = await makeSite('delstop-c', 'delete_scheduled');
    await ctx.db.query("UPDATE sites SET previous_status = 'suspended', purge_at = now() + interval '30 days' WHERE id = $1", [siteId]);

    const cancel = await call('POST', `/api/v1/sites/${siteId}/cancel-delete`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    const row = await siteRow(siteId);
    expect(row.status).toBe('suspended');
    expect(row.purge_at).toBeNull();
    expect(await jobsFor(siteId, 'site.restart')).toHaveLength(0);
  });
});
