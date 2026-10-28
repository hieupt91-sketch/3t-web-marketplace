import type { Queryable } from './db.ts';

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|api[_-]?key|signature|card|iban|account_number)/i;

/** Recursively replace values of sensitive keys; used for audit diffs and structured logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface AuditEntry {
  actorType: 'user' | 'system' | 'worker';
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  traceId: string;
  diff?: Record<string, unknown>;
}

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, resource_id, trace_id, diff_redacted)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.actorType, entry.actorId, entry.action, entry.resourceType, entry.resourceId, entry.traceId, redact(entry.diff ?? {})],
  );
}

export async function emitEvent(db: Queryable, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
  await db.query(
    'INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json) VALUES ($1, $2, $3, $4)',
    [eventType, aggregateType, aggregateId, payload],
  );
}
