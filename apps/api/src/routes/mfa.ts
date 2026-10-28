import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hashToken, writeAudit } from '@3t/core';
import { requireUser, setSessionCookie } from '../app.ts';
import { errors } from '../errors.ts';
import { createSession } from '../lib/identity.ts';
import { decryptSecret, encryptSecret } from '../lib/secret-store.ts';
import { requireStepUp } from '../lib/step-up.ts';
import { generateTotpSecret, totpAuthUri, verifyTotp } from '../lib/totp.ts';

function backupCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

/** MFA (TOTP) + step-up endpoints (docs/04 §5, M1 debt). */
export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/me/mfa', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ verified_at: Date | null }>(
      'SELECT verified_at FROM user_mfa WHERE user_id = $1',
      [auth.userId],
    );
    return { data: { enabled: rows[0]?.verified_at != null, verified_at: rows[0]?.verified_at?.toISOString() ?? null } };
  });

  // Setup requires step-up (fresh password auth): enrollment must not ride on
  // a stale session alone.
  app.post('/me/mfa/setup', async (request, reply) => {
    const auth = requireUser(request);
    await requireStepUp(db, auth);
    const existing = await db.query<{ verified_at: Date | null }>(
      'SELECT verified_at FROM user_mfa WHERE user_id = $1',
      [auth.userId],
    );
    if (existing.rows[0]?.verified_at) throw errors.conflict('mfa.already_enabled');
    const secret = generateTotpSecret();
    await db.query(
      `INSERT INTO user_mfa (user_id, secret_enc, verified_at, backup_codes_hash)
       VALUES ($1, $2, NULL, '{}')
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, verified_at = NULL, backup_codes_hash = '{}'`,
      [auth.userId, encryptSecret(config.mfaKey, secret)],
    );
    return reply.status(201).send({ data: { otpauth_uri: totpAuthUri(secret, auth.email), secret } });
  });

  app.post<{ Body: { code: string } }>(
    '/me/mfa/verify',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', minLength: 6, maxLength: 6 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const { rows } = await db.query<{ secret_enc: string; verified_at: Date | null }>(
        'SELECT secret_enc, verified_at FROM user_mfa WHERE user_id = $1',
        [auth.userId],
      );
      const row = rows[0];
      if (!row || row.verified_at) throw errors.conflict('mfa.not_pending');
      const secret = decryptSecret(config.mfaKey, row.secret_enc);
      if (!verifyTotp(secret, request.body.code)) throw errors.unauthenticated('mfa.code_invalid');
      const codes = Array.from({ length: 10 }, () => backupCode());
      await db.query(
        'UPDATE user_mfa SET verified_at = now(), backup_codes_hash = $2 WHERE user_id = $1',
        [auth.userId, codes.map((c) => hashToken(c).toString('hex'))],
      );
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'mfa.enabled', resourceType: 'user', resourceId: auth.userId, traceId: request.id });
      return reply.status(200).send({ data: { enabled: true, backup_codes: codes } });
    },
  );

  app.post('/me/mfa/disable', async (request, reply) => {
    const auth = requireUser(request);
    await requireStepUp(db, auth);
    const { rowCount } = await db.query('DELETE FROM user_mfa WHERE user_id = $1', [auth.userId]);
    if (rowCount === 0) throw errors.notFound();
    await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'mfa.disabled', resourceType: 'user', resourceId: auth.userId, traceId: request.id });
    return reply.status(200).send({ data: { enabled: false } });
  });

  // Login second step: a challenge token plus a TOTP code (or a single-use
  // backup code) yields the real session.
  app.post<{ Body: { challenge_token: string; code: string } }>(
    '/auth/mfa-challenge',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: { body: { type: 'object', additionalProperties: false, required: ['challenge_token', 'code'], properties: { challenge_token: { type: 'string', minLength: 1 }, code: { type: 'string', minLength: 6, maxLength: 10 } } } } },
    async (request, reply) => {
      const { rows } = await db.query<{ user_id: string }>(
        'SELECT user_id FROM mfa_challenges WHERE token_hash = $1 AND expires_at > now()',
        [hashToken(request.body.challenge_token).toString('hex')],
      );
      const challenge = rows[0];
      if (!challenge) throw errors.unauthenticated('mfa.challenge_invalid');
      const mfa = await db.query<{ secret_enc: string; backup_codes_hash: string[] }>(
        'SELECT secret_enc, backup_codes_hash FROM user_mfa WHERE user_id = $1 AND verified_at IS NOT NULL',
        [challenge.user_id],
      );
      const row = mfa.rows[0];
      if (!row) throw errors.unauthenticated('mfa.challenge_invalid');
      const secret = decryptSecret(config.mfaKey, row.secret_enc);
      const codeHash = hashToken(request.body.code).toString('hex');
      const backupIndex = row.backup_codes_hash.indexOf(codeHash);
      if (!verifyTotp(secret, request.body.code) && backupIndex === -1) {
        throw errors.unauthenticated('mfa.code_invalid');
      }
      // Single-use on success: a failed guess does not consume the challenge
      // (the route itself is rate-limited instead).
      await db.query('DELETE FROM mfa_challenges WHERE token_hash = $1', [hashToken(request.body.challenge_token).toString('hex')]);
      if (backupIndex !== -1) {
        const remaining = row.backup_codes_hash.filter((_, i) => i !== backupIndex);
        await db.query('UPDATE user_mfa SET backup_codes_hash = $2 WHERE user_id = $1', [challenge.user_id, remaining]);
      }
      const session = await createSession(db, challenge.user_id, config.sessionTtlHours, request.headers['user-agent']);
      await writeAudit(db, { actorType: 'user', actorId: challenge.user_id, action: 'session.created', resourceType: 'session', resourceId: session.id, traceId: request.id });
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { data: { status: 'signed_in', expires_at: session.expiresAt.toISOString() } };
    },
  );
}
