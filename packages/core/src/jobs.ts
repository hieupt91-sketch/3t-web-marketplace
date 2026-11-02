import type { Db, Queryable } from './db.ts';

/**
 * SQL-backed job queue (docs/02 §7): claim with row lock + SKIP LOCKED, lease with heartbeat,
 * fencing token incremented on every claim so a stale worker cannot complete a re-claimed job.
 */
export interface JobRow {
  id: string;
  type: string;
  payload_json: Record<string, unknown>;
  dedupe_key: string;
  resource_type: string | null;
  resource_id: string | null;
  owner_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';
  attempts: number;
  max_attempts: number;
  fencing_token: string;
  lease_until: Date | null;
  step: string | null;
  completed_steps: number;
  total_steps: number | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueInput {
  type: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  resourceType?: string;
  resourceId?: string;
  ownerId?: string | null;
  maxAttempts?: number;
  totalSteps?: number;
  runAt?: Date;
}

/** Insert a job; returns the existing job when the dedupe key was already used. */
export async function enqueueJob(db: Queryable, input: EnqueueInput): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await db.query<JobRow>(
    `INSERT INTO jobs (type, dedupe_key, payload_json, resource_type, resource_id, owner_id, max_attempts, total_steps, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()))
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [
      input.type,
      input.dedupeKey,
      input.payload,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.ownerId ?? null,
      input.maxAttempts ?? 5,
      input.totalSteps ?? null,
      input.runAt ?? null,
    ],
  );
  if (inserted.rows[0]) return { job: inserted.rows[0], created: true };
  const existing = await db.query<JobRow>('SELECT * FROM jobs WHERE dedupe_key = $1', [input.dedupeKey]);
  return { job: existing.rows[0] as JobRow, created: false };
}

export async function claimJob(db: Db, workerId: string, types: string[], leaseSeconds: number): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, fencing_token = fencing_token + 1,
            lease_owner = $1, lease_until = now() + make_interval(secs => $3)
     WHERE id = (
       SELECT id FROM jobs
       WHERE type = ANY($2) AND (
         (status = 'queued' AND next_run_at <= now()) OR
         (status = 'running' AND lease_until < now()))
       ORDER BY next_run_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING *`,
    [workerId, types, leaseSeconds],
  );
  return rows[0] ?? null;
}

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease lost for job ${jobId}`);
  }
}

export async function heartbeat(db: Queryable, job: JobRow, leaseSeconds: number, progress?: { step?: string; completedSteps?: number }): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET lease_until = now() + make_interval(secs => $3),
            step = COALESCE($4, step), completed_steps = COALESCE($5, completed_steps)
     WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [job.id, job.fencing_token, leaseSeconds, progress?.step ?? null, progress?.completedSteps ?? null],
  );
  if (rowCount !== 1) throw new LeaseLostError(job.id);
}

export async function completeJob(db: Queryable, job: JobRow): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'succeeded', lease_until = NULL, lease_owner = NULL, finished_at = now(), last_error_code = NULL
     WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [job.id, job.fencing_token],
  );
  if (rowCount !== 1) throw new LeaseLostError(job.id);
}

/** Exponential backoff with full jitter, capped (seconds). */
export function backoffSeconds(attempt: number, baseSeconds = 5, capSeconds = 900, random = Math.random): number {
  const ceiling = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(random() * ceiling));
}

/**
 * Record a failure. Retryable failures are rescheduled until max_attempts, then moved to `dead`
 * (needs attention). Non-retryable failures end as `failed` immediately.
 */
export async function failJob(db: Queryable, job: JobRow, errorCode: string, retryable: boolean): Promise<'queued' | 'failed' | 'dead'> {
  const next = !retryable ? 'failed' : job.attempts >= job.max_attempts ? 'dead' : 'queued';
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = $3, last_error_code = $4, lease_until = NULL, lease_owner = NULL,
            next_run_at = CASE WHEN $3 = 'queued' THEN now() + make_interval(secs => $5) ELSE next_run_at END,
            finished_at = CASE WHEN $3 = 'queued' THEN NULL ELSE now() END
     WHERE id = $1 AND fencing_token = $2 AND status = 'running'`,
    [job.id, job.fencing_token, next, errorCode, backoffSeconds(job.attempts)],
  );
  if (rowCount !== 1) throw new LeaseLostError(job.id);
  return next;
}

export async function cancelJob(db: Queryable, job: JobRow): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'cancelled', lease_until = NULL, lease_owner = NULL, finished_at = now()
     WHERE id = $1 AND fencing_token = $2`,
    [job.id, job.fencing_token],
  );
}

/** Re-queue a finished job for a manual retry; refuses while a valid lease is held. */
export async function requeueJob(db: Queryable, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'queued', next_run_at = now(), finished_at = NULL,
            max_attempts = GREATEST(max_attempts, attempts + 1)
     WHERE id = $1 AND status IN ('failed', 'dead', 'cancelled')`,
    [jobId],
  );
  return rowCount === 1;
}
