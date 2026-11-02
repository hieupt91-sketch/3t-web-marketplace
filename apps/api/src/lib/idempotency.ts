import type { PoolClient } from '@3t/core';
import { sha256Hex, tx, type Db } from '@3t/core';
import { errors } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface IdempotentResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Execute a mutation once per (principal, route, Idempotency-Key) (docs/04 §1).
 * The record is written in the same transaction as the mutation; a concurrent request with the
 * same key blocks on the unique key until the first commits, then replays its stored response.
 * Same key with a different body → 409.
 */
export async function idempotent(
  db: Db,
  opts: { key: unknown; principal: string; route: string; request: unknown },
  handler: (client: PoolClient) => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  if (typeof opts.key !== 'string' || !UUID.test(opts.key)) throw errors.badRequest('request.idempotency_key_required');
  const requestHash = sha256Hex(canonical(opts.request));
  return tx(db, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_records (principal_scope, route, key, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT DO NOTHING RETURNING key`,
      [opts.principal, opts.route, opts.key, requestHash],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await client.query<{ request_hash: string; status: string; response_status: number; response_json: unknown }>(
        'SELECT request_hash, status, response_status, response_json FROM idempotency_records WHERE principal_scope = $1 AND route = $2 AND key = $3',
        [opts.principal, opts.route, opts.key],
      );
      const existing = rows[0];
      if (!existing || existing.request_hash !== requestHash) throw errors.conflict('idempotency.key_reused');
      if (existing.status !== 'completed') throw errors.conflict('idempotency.in_progress', true);
      return { status: existing.response_status, body: existing.response_json, replayed: true };
    }
    const result = await handler(client);
    await client.query(
      `UPDATE idempotency_records SET status = 'completed', response_status = $4, response_json = $5
       WHERE principal_scope = $1 AND route = $2 AND key = $3`,
      [opts.principal, opts.route, opts.key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  });
}
