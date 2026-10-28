import type { PoolClient } from '@3t/core';
import { hashToken, randomToken, type Queryable } from '@3t/core';
import { errors } from '../errors.ts';

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().normalize('NFC').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Password policy shown before submit (U01): 12–128 chars, not the email itself. */
export function passwordIssues(password: unknown, email: string | null): string[] {
  if (typeof password !== 'string') return ['required'];
  const issues: string[] = [];
  if ([...password].length < 12) issues.push('too_short');
  if ([...password].length > 128) issues.push('too_long');
  const local = email?.split('@')[0] ?? '';
  // Only meaningful for distinctive local parts; "a@x.com" must not ban every password with an "a".
  if (local.length >= 4 && password.toLowerCase().includes(local)) issues.push('contains_email');
  return issues;
}

export const TOKEN_TTL_MINUTES = { verify_email: 24 * 60, reset_password: 30 } as const;

/** Issue a one-time token; previous unused tokens of the same purpose are revoked. */
export async function issueAuthToken(db: Queryable, userId: string, purpose: keyof typeof TOKEN_TTL_MINUTES): Promise<string> {
  await db.query(
    'UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL',
    [userId, purpose],
  );
  const token = randomToken();
  await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, purpose, hashToken(token), TOKEN_TTL_MINUTES[purpose]],
  );
  return token;
}

/** Consume a one-time token inside a transaction; distinguishes invalid/expired/used for U03/U05. */
export async function consumeAuthToken(client: PoolClient, token: unknown, purpose: keyof typeof TOKEN_TTL_MINUTES): Promise<string> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw errors.validation([{ field: 'token', code: 'invalid' }], 'auth.token_invalid');
  const { rows } = await client.query<{ id: string; user_id: string; expired: boolean; used_at: Date | null; revoked_at: Date | null }>(
    `SELECT id, user_id, expires_at <= now() AS expired, used_at, revoked_at FROM auth_tokens
     WHERE token_hash = $1 AND purpose = $2 FOR UPDATE`,
    [hashToken(token), purpose],
  );
  const row = rows[0];
  if (!row || row.revoked_at) throw errors.validation([{ field: 'token', code: 'invalid' }], 'auth.token_invalid');
  if (row.used_at) throw errors.validation([{ field: 'token', code: 'used' }], 'auth.token_used');
  if (row.expired) throw errors.validation([{ field: 'token', code: 'expired' }], 'auth.token_expired');
  await client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
  return row.user_id;
}

export async function createSession(db: Queryable, userId: string, ttlHours: number, userAgent: string | undefined) {
  const token = randomToken();
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id, expires_at`,
    [userId, hashToken(token), userAgent?.slice(0, 300) ?? null, ttlHours],
  );
  return { token, id: rows[0]!.id, expiresAt: rows[0]!.expires_at };
}
