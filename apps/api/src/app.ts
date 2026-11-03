import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { hashToken, sessionLimits, sessionRejectionReason, shouldRefreshLastSeen, type Db, type LocalObjectStore, type MockPaymentProvider, type PlatformConfig } from '@3t/core';
import { MESSAGES, negotiateLocale, translate, type Locale } from '@3t/i18n';
import { AppError, errors } from './errors.ts';
import type { Mailer } from './mail.ts';
import { publicRoutes } from './routes/public.ts';
import { adminStatsRoutes, publicAnalyticsRoutes } from './routes/analytics.ts';
import { publicContentRoutes } from './routes/public-content.ts';
import { authRoutes } from './routes/auth.ts';
import { meRoutes } from './routes/me.ts';
import { adminImportRoutes } from './routes/admin-imports.ts';
import { adminCatalogRoutes } from './routes/admin-catalog.ts';
import { adminContentRoutes } from './routes/admin-content.ts';
import { adminAdsSettingsRoutes, adminGatewaySettingsRoutes, adminManualPaymentRoutes, adminPaymentSettingsRoutes, adminSettingsRoutes } from './routes/admin-settings.ts';
import { adminTemplateRoutes } from './routes/admin-templates.ts';
import { jobRoutes } from './routes/jobs.ts';
import { commerceRoutes } from './routes/commerce.ts';
import { adminCommerceRoutes } from './routes/admin-commerce.ts';
import { adminGithubRoutes } from './routes/admin-github.ts';
import { adminDemoRoutes, demoSessionRoutes } from './routes/demo-sessions.ts';
import { adminSupportRoutes, supportRoutes } from './routes/support.ts';
import { PgRateLimitStore } from './lib/rate-limit-store.ts';
import { adminHostingRoutes } from './routes/admin-hosting.ts';
import { siteRoutes } from './routes/sites.ts';
import { adminPartnerRoutes } from './routes/admin-partner.ts';
import { partnerPortalRoutes } from './routes/partner-portal.ts';
import { mfaRoutes } from './routes/mfa.ts';
import { adminStaffRoutes } from './routes/admin-staff.ts';
import { adminTranslationRoutes } from './routes/admin-translations.ts';
import { partnerV1Routes } from './routes/partner-v1.ts';

export const SESSION_COOKIE = 'mp_session';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  verified: boolean;
  preferredLocale: Locale;
  timezone: string;
  rowVersion: number;
  roles: string[];
  permissions: Set<string>;
}

export interface AppDeps {
  config: PlatformConfig;
  db: Db;
  store: LocalObjectStore;
  mailer: Mailer;
  payment: MockPaymentProvider;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    sessionInvalid: boolean;
    locale: Locale;
    /** Exact request bytes for webhook routes that verify HMAC over the raw body (audit L-01). */
    rawBody?: string;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

/**
 * Path shape safe for request logs (audit L-04): query strings are
 * dropped (they may carry one-time tokens) and the token segment of
 * token-in-path routes is redacted — today that is the one-time bundle
 * download, `GET /api/v1/downloads/:token` (the only `:token` route;
 * keep this list in step when new ones are added). Everything else
 * passes through unchanged.
 */
export function redactRequestPath(url: string): string {
  const path = url.split('?')[0]!;
  return path.replace(/(\/downloads\/)[^/]+/g, '$1[redacted]');
}

/** Localised message for an error code; unknown codes get a generic message with the request ID shown by the UI. */
export function errorMessage(locale: Locale, code: string): string {
  const key = `error.${code}`;
  return key in MESSAGES[locale] || key in MESSAGES.vi ? translate(locale, key) : translate(locale, 'error.generic');
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function loadSession(request: FastifyRequest, db: Db, config: PlatformConfig): Promise<void> {
  request.auth = null;
  request.sessionInvalid = false;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    email_normalized: string;
    display_name: string;
    verified_at: Date | null;
    preferred_locale: Locale;
    timezone: string;
    row_version: number;
    roles: string[];
    permissions: string[];
    created_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email_normalized, u.display_name, u.verified_at,
            u.preferred_locale, u.timezone, u.row_version,
            s.created_at, s.last_seen_at,
            COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
            COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.status = 'active'
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
     GROUP BY s.id, u.id`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) {
    request.sessionInvalid = true;
    return;
  }
  // Lifetime policy (audit L-03, values in core config): an absolute
  // cap and an idle timeout, both keyed on the user's CURRENT role
  // class. A session past either limit is rejected AND revoked, so it
  // cannot be revived by a later role removal. Pre-policy sessions are
  // not bulk-revoked at deploy; they simply fail this check on next use.
  const now = new Date();
  const reason = sessionRejectionReason(sessionLimits(config, row.roles.length > 0), row.created_at, row.last_seen_at, now);
  if (reason) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.session_id]);
    request.sessionInvalid = true;
    return;
  }
  request.auth = {
    userId: row.user_id,
    sessionId: row.session_id,
    email: row.email_normalized,
    displayName: row.display_name,
    verified: row.verified_at !== null,
    preferredLocale: row.preferred_locale,
    timezone: row.timezone,
    rowVersion: row.row_version,
    roles: row.roles,
    permissions: new Set(row.permissions),
  };
  // Touch throttled to once per 5 minutes to avoid a write per request.
  if (shouldRefreshLastSeen(row.last_seen_at, now)) {
    await db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'", [row.session_id]);
  }
}

/**
 * CSRF defence for cookie-authenticated mutations (docs/04 §1): the browser must send an Origin
 * equal to the portal origin, or Sec-Fetch-Site: same-origin when Origin is absent.
 */
function checkOrigin(request: FastifyRequest, portalOrigin: string): void {
  if (!MUTATING.has(request.method)) return;
  // Provider webhooks and the Partner API are server-to-server (no Origin) and are authenticated
  // by signature / Bearer key, not by a session cookie, so the CSRF origin check does not apply.
  if (request.url.startsWith('/api/v1/payments/webhooks/') || request.url.startsWith('/api/v1/payments/refund-webhooks/') || request.url.startsWith('/api/v1/admin/imports/github-webhook') || request.url.startsWith('/api/v1/partner/v1/')) return;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (origin !== portalOrigin) throw errors.forbidden('security.origin_mismatch');
    return;
  }
  if (request.headers['sec-fetch-site'] !== 'same-origin') throw errors.forbidden('security.origin_mismatch');
}

export function requireUser(request: FastifyRequest): AuthContext {
  if (!request.auth) throw errors.unauthenticated(request.sessionInvalid ? 'auth.session_expired' : 'auth.session_required');
  return request.auth;
}

/** Permission check at the API, never just UI hiding (docs/11 §4). */
export function requirePermission(request: FastifyRequest, permission: string): AuthContext {
  const auth = requireUser(request);
  if (!auth.permissions.has(permission)) throw errors.forbidden();
  return auth;
}

export function setSessionCookie(reply: FastifyReply, config: PlatformConfig, token: string, expiresAt: Date): void {
  // Host-only cookie: no Domain attribute, so it never reaches preview/demo origins (ADR-005).
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: PlatformConfig): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' });
}

export async function buildApp(deps: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' },
          serializers: {
            // Never log query strings or token path segments: they may carry one-time tokens.
            req: (req: { method: string; url: string; id: string }) => ({ method: req.method, path: redactRequestPath(req.url), id: req.id }),
          },
        }
      : false,
    genReqId: () => `req_${randomBytes(12).toString('base64url')}`,
    trustProxy: deps.config.env === 'production',
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, allErrors: true, coerceTypes: false } },
  });
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);
  app.decorateRequest('sessionInvalid', false);
  app.decorateRequest('locale', 'vi');

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    // Shared Postgres store (M1 debt): every instance counts against the same
    // buckets, unlike the plugin's default in-memory store.
    store: PgRateLimitStore.create(deps.db),
    errorResponseBuilder: (_req, context) => {
      const err = errors.tooMany(Math.ceil(context.ttl / 1000));
      return Object.assign(new Error(err.code), { statusCode: 429, appError: err });
    },
  });

  // Large uploads are streamed by the dedicated route; the parser hands over the raw stream.
  app.addContentTypeParser(['application/zip', 'application/octet-stream'], (_req, payload, done) => done(null, payload));

  // Raw-body capture for HMAC-verified webhooks (audit L-01): for the
  // webhook prefixes, the exact received bytes are stashed on
  // request.rawBody so signature verification binds to what was
  // actually sent, not a re-serialisation of the parsed JSON. Every
  // other route gets exactly the parsed body it got from Fastify's
  // default JSON parser (empty body → {}).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string;
    if (request.url.startsWith('/api/v1/admin/imports/github-webhook')) request.rawBody = raw;
    if (raw.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // HSTS alongside the portal's (audit UI-MED-02): one year, no preload.
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (request.url.startsWith('/api/')) {
      // API responses are JSON, never framed documents (audit
      // UI-INFO-01): deny all framing and all resource loads.
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      reply.header('x-frame-options', 'DENY');
    }
    if (!request.url.startsWith('/api/')) return;
    checkOrigin(request, deps.config.portalOrigin);
    await loadSession(request, deps.db, deps.config);
    const query = request.query as Record<string, unknown> | undefined;
    request.locale = negotiateLocale({
      explicit: typeof query?.locale === 'string' ? query.locale : undefined,
      userPreference: request.auth?.preferredLocale,
      acceptLanguage: request.headers['accept-language'],
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-language', request.locale);
    return payload;
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: { instancePath: string; params: Record<string, unknown>; keyword: string }[]; appError?: AppError; code?: string }, request, reply) => {
    let appError: AppError;
    if (error instanceof AppError) appError = error;
    else if (error.appError instanceof AppError) appError = error.appError;
    else if (error.validation) {
      appError = errors.validation(
        error.validation.map((v) => {
          const missing = v.params.missingProperty as string | undefined;
          const extra = v.params.additionalProperty as string | undefined;
          const path = v.instancePath.replace(/^\//, '').replace(/\//g, '.');
          const field = [path, missing ?? extra].filter(Boolean).join('.') || 'body';
          return { field, code: v.keyword === 'required' ? 'required' : v.keyword === 'additionalProperties' ? 'unknown_field' : `invalid_${v.keyword}` };
        }),
      );
    } else if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') appError = new AppError(415, 'request.unsupported_media_type');
    else if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') appError = new AppError(413, 'request.body_too_large');
    else if (error.statusCode === 400) appError = errors.badRequest();
    else {
      request.log.error({ err: { message: error.message, code: error.code } }, 'unhandled error');
      appError = new AppError(500, 'internal.error', [], true);
    }
    for (const [k, v] of Object.entries(appError.headers)) reply.header(k, v);
    void reply.status(appError.status).send({
      error: {
        code: appError.code,
        message: errorMessage(request.locale, appError.code),
        field_errors: appError.fieldErrors,
        request_id: request.id,
        retryable: appError.retryable,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: { code: 'route.not_found', message: errorMessage(request.locale, 'route.not_found'), field_errors: [], request_id: request.id, retryable: false } });
  });

  await app.register(
    async (api) => {
      await api.register(publicRoutes);
      await api.register(publicAnalyticsRoutes);
      await api.register(publicContentRoutes);
      await api.register(authRoutes);
      await api.register(meRoutes);
      await api.register(adminImportRoutes, { prefix: '/admin' });
      await api.register(adminCatalogRoutes, { prefix: '/admin' });
      await api.register(adminTemplateRoutes, { prefix: '/admin' });
      await api.register(adminContentRoutes, { prefix: '/admin' });
      await api.register(adminSettingsRoutes, { prefix: '/admin' });
      await api.register(adminStatsRoutes, { prefix: '/admin' });
      await api.register(adminPaymentSettingsRoutes, { prefix: '/admin' });
      await api.register(adminGatewaySettingsRoutes, { prefix: '/admin' });
      await api.register(adminAdsSettingsRoutes, { prefix: '/admin' });
      await api.register(adminManualPaymentRoutes, { prefix: '/admin' });
      await api.register(jobRoutes);
      await api.register(commerceRoutes);
      await api.register(adminCommerceRoutes, { prefix: '/admin' });
      await api.register(adminGithubRoutes, { prefix: '/admin' });
      await api.register(demoSessionRoutes);
      await api.register(adminDemoRoutes, { prefix: '/admin' });
      await api.register(supportRoutes);
      await api.register(adminSupportRoutes, { prefix: '/admin' });
      await api.register(siteRoutes);
      await api.register(adminHostingRoutes, { prefix: '/admin' });
      await api.register(partnerPortalRoutes);
      await api.register(mfaRoutes);
      await api.register(adminStaffRoutes, { prefix: '/admin' });
      await api.register(adminTranslationRoutes, { prefix: '/admin' });
      await api.register(partnerV1Routes, { prefix: '/partner/v1' });
      await api.register(adminPartnerRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );
  app.get('/healthz', async () => ({ status: 'ok' }));
  return app;
}
