import type { FastifyInstance, FastifyRequest } from 'fastify';
import { dummyPasswordCheck, hashPassword, hashToken, tx, verifyPassword, writeAudit, isUniqueViolation } from '@3t/core';
import { isLocale, type Locale } from '@3t/i18n';
import { clearSessionCookie, setSessionCookie } from '../app.ts';
import { errors } from '../errors.ts';
import { consumeAuthToken, createSession, issueAuthToken, normalizeEmail, passwordIssues } from '../lib/identity.ts';

const authLimit = (max: number, perEmail = false) => ({
  rateLimit: {
    max,
    timeWindow: '15 minutes',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => {
      const email = perEmail ? normalizeEmail((req.body as { email?: unknown } | undefined)?.email) : null;
      return email ? `${req.ip}|${email}` : req.ip;
    },
  },
});

const ACCEPTED = { data: { status: 'accepted' } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer } = app.deps;
  const link = (path: string, token: string, locale: Locale) => `${config.portalOrigin}${path}?token=${encodeURIComponent(token)}&locale=${locale}`;

  app.post<{ Body: { email: string; password: string; display_name: string; locale?: string; accept_terms: boolean } }>(
    '/auth/register',
    {
      config: authLimit(10),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password', 'display_name', 'accept_terms'],
          properties: {
            email: { type: 'string', maxLength: 254 },
            password: { type: 'string', maxLength: 512 },
            display_name: { type: 'string', minLength: 1, maxLength: 120 },
            locale: { type: 'string' },
            accept_terms: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const email = normalizeEmail(body.email);
      const fieldErrors = [];
      if (!email) fieldErrors.push({ field: 'email', code: 'invalid' });
      for (const code of passwordIssues(body.password, email)) fieldErrors.push({ field: 'password', code });
      if (body.accept_terms !== true) fieldErrors.push({ field: 'accept_terms', code: 'required' });
      if (body.display_name.trim() === '') fieldErrors.push({ field: 'display_name', code: 'required' });
      if (fieldErrors.length) throw errors.validation(fieldErrors);
      const locale: Locale = isLocale(body.locale) ? body.locale : request.locale;
      // Hash even when the account exists so the response time does not reveal it.
      const passwordHash = await hashPassword(body.password, config.passwordHashCost);
      let mail: { template: 'verify_email' | 'account_exists'; token?: string; to: string; locale: Locale };
      try {
        mail = await tx(db, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO users (email_normalized, display_name, password_hash, preferred_locale)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [email, body.display_name.trim(), passwordHash, locale],
          );
          const userId = rows[0]!.id;
          const token = await issueAuthToken(client, userId, 'verify_email');
          await writeAudit(client, { actorType: 'user', actorId: userId, action: 'user.registered', resourceType: 'user', resourceId: userId, traceId: request.id });
          return { template: 'verify_email' as const, token, to: email!, locale };
        });
      } catch (error) {
        if (!isUniqueViolation(error, 'users_email_normalized_uq')) throw error;
        const { rows } = await db.query<{ preferred_locale: Locale }>('SELECT preferred_locale FROM users WHERE email_normalized = $1', [email]);
        mail = { template: 'account_exists', to: email!, locale: rows[0]?.preferred_locale ?? locale };
      }
      await mailer.send({
        to: mail.to,
        locale: mail.locale,
        template: mail.template,
        params: mail.token ? { link: link('/auth/verify', mail.token, mail.locale) } : { link: `${config.portalOrigin}/auth/forgot-password` },
      });
      return reply.status(202).send(ACCEPTED);
    },
  );

  app.post<{ Body: { token: string } }>(
    '/auth/verify-email',
    { config: authLimit(30), schema: { body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string' } } } } },
    async (request) => {
      const userId = await tx(db, async (client) => {
        const id = await consumeAuthToken(client, request.body.token, 'verify_email');
        await client.query('UPDATE users SET verified_at = COALESCE(verified_at, now()), row_version = row_version + 1 WHERE id = $1', [id]);
        await writeAudit(client, { actorType: 'user', actorId: id, action: 'user.email_verified', resourceType: 'user', resourceId: id, traceId: request.id });
        return id;
      });
      return { data: { status: 'verified', user_id: userId } };
    },
  );

  app.post<{ Body: { email: string } }>(
    '/auth/resend-verification',
    { config: authLimit(5), schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', maxLength: 254 } } } } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (email) {
        const { rows } = await db.query<{ id: string; preferred_locale: Locale; recent: boolean }>(
          `SELECT u.id, u.preferred_locale,
                  EXISTS (SELECT 1 FROM auth_tokens t WHERE t.user_id = u.id AND t.purpose = 'verify_email'
                          AND t.created_at > now() - interval '60 seconds') AS recent
           FROM users u WHERE u.email_normalized = $1 AND u.verified_at IS NULL AND u.status = 'active'`,
          [email],
        );
        const user = rows[0];
        // Cooldown silently: the response must be identical either way.
        if (user && !user.recent) {
          const token = await issueAuthToken(db, user.id, 'verify_email');
          await mailer.send({ to: email, locale: user.preferred_locale, template: 'verify_email', params: { link: link('/auth/verify', token, user.preferred_locale) } });
        }
      }
      return reply.status(202).send(ACCEPTED);
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      config: authLimit(10, true),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const { rows } = email
        ? await db.query<{ id: string; password_hash: string | null; status: string }>(
            'SELECT id, password_hash, status FROM users WHERE email_normalized = $1',
            [email],
          )
        : { rows: [] };
      const user = rows[0];
      if (!user) {
        await dummyPasswordCheck(request.body.password, config.passwordHashCost);
        throw errors.unauthenticated('auth.invalid_credentials');
      }
      const ok = await verifyPassword(request.body.password, user.password_hash);
      if (!ok || user.status !== 'active') throw errors.unauthenticated('auth.invalid_credentials');
      const session = await createSession(db, user.id, config.sessionTtlHours, request.headers['user-agent']);
      await writeAudit(db, { actorType: 'user', actorId: user.id, action: 'session.created', resourceType: 'session', resourceId: session.id, traceId: request.id });
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { data: { status: 'signed_in', expires_at: session.expiresAt.toISOString() } };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies.mp_session;
    if (token) await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });

  app.post<{ Body: { email: string } }>(
    '/auth/forgot-password',
    { config: authLimit(5, true), schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string', maxLength: 254 } } } } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (email) {
        const { rows } = await db.query<{ id: string; preferred_locale: Locale }>(
          "SELECT id, preferred_locale FROM users WHERE email_normalized = $1 AND status = 'active'",
          [email],
        );
        const user = rows[0];
        if (user) {
          const token = await issueAuthToken(db, user.id, 'reset_password');
          await mailer.send({ to: email, locale: user.preferred_locale, template: 'reset_password', params: { link: link('/auth/reset-password', token, user.preferred_locale) } });
        }
      }
      return reply.status(202).send(ACCEPTED);
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/auth/reset-password',
    {
      config: authLimit(10),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token', 'password'],
          properties: { token: { type: 'string' }, password: { type: 'string', maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const issues = passwordIssues(request.body.password, null);
      if (issues.length) throw errors.validation(issues.map((code) => ({ field: 'password', code })));
      const passwordHash = await hashPassword(request.body.password, config.passwordHashCost);
      const user = await tx(db, async (client) => {
        const userId = await consumeAuthToken(client, request.body.token, 'reset_password');
        const { rows } = await client.query<{ email_normalized: string; preferred_locale: Locale }>(
          'UPDATE users SET password_hash = $2, row_version = row_version + 1 WHERE id = $1 RETURNING email_normalized, preferred_locale',
          [userId, passwordHash],
        );
        // Policy: a password reset signs out every device.
        await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        await writeAudit(client, { actorType: 'user', actorId: userId, action: 'user.password_reset', resourceType: 'user', resourceId: userId, traceId: request.id });
        return rows[0]!;
      });
      await mailer.send({ to: user.email_normalized, locale: user.preferred_locale, template: 'password_changed', params: { link: `${config.portalOrigin}/auth/forgot-password` } });
      clearSessionCookie(reply, config);
      return { data: { status: 'password_reset' } };
    },
  );
}
