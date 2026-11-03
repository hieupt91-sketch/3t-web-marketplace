import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backoffSeconds, claimJob, clearJobResult, completeJob, enqueueJob, failJob, heartbeat, LeaseLostError, requeueJob, setJobResult } from './jobs.ts';
import { createTestDatabase } from './testing.ts';
import type { Db } from './db.ts';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => {
  ({ pool: db, drop } = await createTestDatabase());
});
afterAll(async () => drop());

describe('job queue', () => {
  it('dedupes by key', async () => {
    const a = await enqueueJob(db, { type: 't.dedupe', dedupeKey: 'k1', payload: { n: 1 } });
    const b = await enqueueJob(db, { type: 't.dedupe', dedupeKey: 'k1', payload: { n: 2 } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  it('lets only one worker claim a job and fences stale workers after lease expiry', async () => {
    await enqueueJob(db, { type: 't.lease', dedupeKey: 'lease-1', payload: {} });
    const [first, second] = await Promise.all([claimJob(db, 'w1', ['t.lease'], 30), claimJob(db, 'w2', ['t.lease'], 30)]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
    const stale = claimed[0]!;
    // Simulate a crashed worker: lease expires, another worker reclaims with a higher fencing token.
    await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [stale.id]);
    const fresh = await claimJob(db, 'w3', ['t.lease'], 30);
    expect(fresh?.id).toBe(stale.id);
    expect(Number(fresh!.fencing_token)).toBeGreaterThan(Number(stale.fencing_token));
    await expect(heartbeat(db, stale, 30)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(completeJob(db, stale)).rejects.toBeInstanceOf(LeaseLostError);
    await completeJob(db, fresh!);
    const { rows } = await db.query('SELECT status, attempts FROM jobs WHERE id = $1', [stale.id]);
    expect(rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
  });

  it('retries retryable failures, dead-letters after max attempts, fails fast otherwise', async () => {
    await enqueueJob(db, { type: 't.retry', dedupeKey: 'retry-1', payload: {}, maxAttempts: 2 });
    let job = (await claimJob(db, 'w', ['t.retry'], 30))!;
    expect(await failJob(db, job, 'transient', true)).toBe('queued');
    await db.query('UPDATE jobs SET next_run_at = now() WHERE id = $1', [job.id]);
    job = (await claimJob(db, 'w', ['t.retry'], 30))!;
    expect(await failJob(db, job, 'transient', true)).toBe('dead');
    expect(await requeueJob(db, job.id)).toBe(true);
    job = (await claimJob(db, 'w', ['t.retry'], 30))!;
    expect(await failJob(db, job, 'manifest_invalid', false)).toBe('failed');
  });

  it('does not requeue a running job', async () => {
    await enqueueJob(db, { type: 't.running', dedupeKey: 'running-1', payload: {} });
    const job = (await claimJob(db, 'w', ['t.running'], 30))!;
    expect(await requeueJob(db, job.id)).toBe(false);
  });

  it('computes bounded jittered backoff', () => {
    expect(backoffSeconds(1, 5, 900, () => 1)).toBe(5);
    expect(backoffSeconds(20, 5, 900, () => 1)).toBe(900);
    expect(backoffSeconds(3, 5, 900, () => 0)).toBe(1);
  });
});

describe('schema invariants', () => {
  it('keeps audit logs append-only', async () => {
    await db.query("INSERT INTO audit_logs (actor_type, action, resource_type, trace_id) VALUES ('system', 'x', 'y', 't')");
    await expect(db.query('UPDATE audit_logs SET action = $1', ['changed'])).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });
});

describe('job result channel (migration 0044, H2 fix 1)', () => {
  it('publishes a result while running, keeps it after completion, scrubs on clear', async () => {
    await enqueueJob(db, { type: 't.result', dedupeKey: 'result-1', payload: {} });
    const job = (await claimJob(db, 'w', ['t.result'], 30))!;
    expect(job.result_json).toBeNull();
    await setJobResult(db, job, { token_enc: 'sealed-value' });
    await completeJob(db, job);
    const { rows } = await db.query<{ status: string; result_json: { token_enc: string } | null }>(
      'SELECT status, result_json FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.result_json).toEqual({ token_enc: 'sealed-value' });
    await clearJobResult(db, job.id);
    const after = await db.query<{ result_json: unknown }>('SELECT result_json FROM jobs WHERE id = $1', [job.id]);
    expect(after.rows[0]!.result_json).toBeNull();
  });

  it('fences a stale worker out of publishing a result', async () => {
    await enqueueJob(db, { type: 't.result-fence', dedupeKey: 'result-fence-1', payload: {} });
    const stale = (await claimJob(db, 'w1', ['t.result-fence'], 30))!;
    await db.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [stale.id]);
    const fresh = (await claimJob(db, 'w2', ['t.result-fence'], 30))!;
    await expect(setJobResult(db, stale, { token_enc: 'stale' })).rejects.toBeInstanceOf(LeaseLostError);
    await setJobResult(db, fresh, { token_enc: 'fresh' });
    const { rows } = await db.query<{ result_json: { token_enc: string } | null }>('SELECT result_json FROM jobs WHERE id = $1', [stale.id]);
    expect(rows[0]!.result_json).toEqual({ token_enc: 'fresh' });
  });
});
