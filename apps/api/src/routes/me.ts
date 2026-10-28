import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword, writeAudit } from '@3t/core';
import { requireUser } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { passwordIssues } from '../lib/identity.ts';
import { requireStepUp } from '../lib/step-up.ts';

function etagFor(rowVersion: number): string {
  return `"${rowVersion}"`;
}

function parseIfMatch(header: string | undefined): number | null {
  const match = header?.match(/^(?:W\/)?"(\d+)"$/);
  return match ? Number(match[1]) : null;
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer } = app.deps;

  // Authenticated password change (docs/04 §5): current password + step-up,
  // then every other session is revoked; the current session survives.
  app.post<{ Body: { current_password: string; new_password: string } }>(
    '/me/password-change',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['current_password', 'new_password'], properties: { current_password: { type: 'string', maxLength: 512 }, new_password: { type: 'string', maxLength: 512 } } } } },
    async (request, reply) => {
      const auth = requireUser(request);
      await requireStepUp(db, auth);
      const issues = passwordIssues(request.body.new_password, auth.email);
      if (issues.length) throw errors.validation(issues.map((code) => ({ field: 'new_password', code })));
      const { rows } = await db.query<{ password_hash: string | null; email_normalized: string; preferred_locale: string }>(
        'SELECT password_hash, email_normalized, preferred_locale FROM users WHERE id = $1',
        [auth.userId],
      );
      const user = rows[0];
      if (!user || !(await verifyPassword(request.body.current_password, user.password_hash))) {
        throw errors.unauthenticated('auth.invalid_credentials');
      }
      const passwordHash = await hashPassword(request.body.new_password, config.passwordHashCost);
      await db.query('UPDATE users SET password_hash = $2, row_version = row_version + 1 WHERE id = $1', [auth.userId, passwordHash]);
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'user.password_changed', resourceType: 'user', resourceId: auth.userId, traceId: request.id });
      await mailer.send({ to: user.email_normalized, locale: user.preferred_locale as 'vi' | 'en', template: 'password_changed', params: { link: `${config.portalOrigin}/auth/forgot-password` } });
      return reply.status(200).send({ data: { status: 'password_changed' } });
    },
  );

  app.get('/me', async (request, reply) => {
    const auth = requireUser(request);
    reply.header('etag', etagFor(auth.rowVersion));
    return {
      data: {
        id: auth.userId,
        email: auth.email,
        display_name: auth.displayName,
        verified: auth.verified,
        locale: auth.preferredLocale,
        timezone: auth.timezone,
        roles: auth.roles,
        permissions: [...auth.permissions].sort(),
      },
      meta: { request_id: request.id, revision: auth.rowVersion },
    };
  });

  app.patch<{ Body: { display_name?: string; locale?: 'vi' | 'en'; timezone?: string } }>(
    '/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            display_name: { type: 'string', minLength: 1, maxLength: 120 },
            locale: { enum: ['vi', 'en'] },
            timezone: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) throw new AppError(428, 'request.if_match_required');
      const body = request.body;
      if (body.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: body.timezone });
        } catch {
          throw errors.validation([{ field: 'timezone', code: 'invalid' }]);
        }
      }
      const { rows } = await db.query<{ row_version: number }>(
        `UPDATE users SET display_name = COALESCE($3, display_name), preferred_locale = COALESCE($4, preferred_locale),
                timezone = COALESCE($5, timezone), row_version = row_version + 1
         WHERE id = $1 AND row_version = $2 RETURNING row_version`,
        [auth.userId, expected, body.display_name?.trim() ?? null, body.locale ?? null, body.timezone ?? null],
      );
      if (!rows[0]) throw errors.preconditionFailed();
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'user.profile_updated', resourceType: 'user', resourceId: auth.userId, traceId: request.id, diff: body });
      reply.header('etag', etagFor(rows[0].row_version));
      return { data: { status: 'updated' }, meta: { request_id: request.id, revision: rows[0].row_version } };
    },
  );

  app.get('/me/sessions', async (request) => {
    const auth = requireUser(request);
    const { rows } = await db.query<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      `SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 100`,
      [auth.userId],
    );
    return {
      data: rows.map((s) => ({
        id: s.id,
        user_agent: s.user_agent,
        created_at: s.created_at.toISOString(),
        last_active_at: s.last_seen_at.toISOString(),
        expires_at: s.expires_at.toISOString(),
        current: s.id === auth.sessionId,
      })),
      page: { next_cursor: null, has_more: false },
    };
  });

  app.delete<{ Params: { id: string } }>('/me/sessions/:id', async (request, reply) => {
    const auth = requireUser(request);
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) throw errors.notFound();
    const { rowCount } = await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [request.params.id, auth.userId],
    );
    if (rowCount !== 1) throw errors.notFound();
    await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'session.revoked', resourceType: 'session', resourceId: request.params.id, traceId: request.id });
    return reply.status(204).send();
  });
}
