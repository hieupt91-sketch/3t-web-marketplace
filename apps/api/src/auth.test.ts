import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, sessionCookie, type TestContext } from './test-helpers.ts';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, ...headers } });

function tokenFrom(link: string): string {
  return new URL(link).searchParams.get('token')!;
}

describe('registration and verification (U01/U03, AT-13)', () => {
  it('registers, verifies once, and rejects replay', async () => {
    const res = await post('/api/v1/auth/register', { email: ' New@Example.COM ', password: 'a long enough pass', display_name: 'Lan', accept_terms: true, locale: 'en' });
    expect(res.statusCode).toBe(202);
    const mail = ctx.mailer.sent.at(-1)!;
    expect(mail).toMatchObject({ to: 'new@example.com', template: 'verify_email', locale: 'en' });
    const token = tokenFrom(mail.params.link!);
    const verify = await post('/api/v1/auth/verify-email', { token });
    expect(verify.statusCode).toBe(200);
    const replay = await post('/api/v1/auth/verify-email', { token });
    expect(replay.statusCode).toBe(422);
    expect(replay.json().error.code).toBe('auth.token_used');
  });

  it('does not reveal whether an email already exists', async () => {
    await post('/api/v1/auth/register', { email: 'dup@example.com', password: 'a long enough pass', display_name: 'A', accept_terms: true });
    const second = await post('/api/v1/auth/register', { email: 'DUP@example.com', password: 'another long pass', display_name: 'B', accept_terms: true });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ data: { status: 'accepted' } });
    expect(ctx.mailer.sent.at(-1)!.template).toBe('account_exists');
  });

  it('validates password policy and terms with field errors', async () => {
    const res = await post('/api/v1/auth/register', { email: 'x@example.com', password: 'short', display_name: 'X', accept_terms: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field_errors).toEqual(
      expect.arrayContaining([
        { field: 'password', code: 'too_short' },
        { field: 'accept_terms', code: 'required' },
      ]),
    );
  });

  it('does not reject passwords for sharing letters with a short email local part', async () => {
    const res = await post('/api/v1/auth/register', { email: 'ab@example.com', password: 'a long enough pass', display_name: 'AB', accept_terms: true });
    expect(res.statusCode).toBe(202);
    const owned = await post('/api/v1/auth/register', { email: 'lanpham@example.com', password: 'xx lanpham 2026 xx', display_name: 'L', accept_terms: true });
    expect(owned.json().error.field_errors).toContainEqual({ field: 'password', code: 'contains_email' });
  });

  it('rejects unknown fields and wrong types as validation errors', async () => {
    const res = await post('/api/v1/auth/register', { email: 'x@example.com', password: 'a long enough pass', display_name: 'X', accept_terms: true, is_admin: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field_errors[0]).toMatchObject({ code: 'unknown_field' });
  });
});

describe('login, sessions, logout', () => {
  it('uses one generic error for wrong password and unknown account', async () => {
    await createUser(ctx, 'login@example.com');
    const wrong = await post('/api/v1/auth/login', { email: 'login@example.com', password: 'wrong password!!' });
    const unknown = await post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'wrong password!!' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
  });

  it('sets a host-only HttpOnly SameSite=Lax cookie and revokes it on logout', async () => {
    await createUser(ctx, 'cookie@example.com');
    const res = await post('/api/v1/auth/login', { email: 'cookie@example.com', password: 'correct horse battery staple' });
    const cookie = res.cookies.find((c) => c.name === 'mp_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie.domain).toBeUndefined();
    const auth = sessionCookie(res);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: auth } });
    expect(me.json().data).toMatchObject({ email: 'cookie@example.com', verified: true });
    expect(me.headers.etag).toBe('"1"');
    await post('/api/v1/auth/logout', {}, { cookie: auth });
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: auth } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('auth.session_expired');
  });

  it('lists and revokes own sessions only', async () => {
    const a = await createUser(ctx, 'sess-a@example.com');
    const b = await createUser(ctx, 'sess-b@example.com');
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/sessions', headers: { cookie: b.cookie } });
    const sessionB = list.json().data[0].id as string;
    const foreign = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/me/sessions/${sessionB}`, headers: { cookie: a.cookie, origin: ORIGIN } });
    expect(foreign.statusCode).toBe(404);
    const own = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/me/sessions/${sessionB}`, headers: { cookie: b.cookie, origin: ORIGIN } });
    expect(own.statusCode).toBe(204);
  });
});

describe('password reset (U04/U05, AT-13)', () => {
  it('answers identically for unknown accounts and revokes sessions on reset', async () => {
    const user = await createUser(ctx, 'reset@example.com');
    const before = ctx.mailer.sent.length;
    const unknown = await post('/api/v1/auth/forgot-password', { email: 'ghost@example.com' });
    expect(unknown.statusCode).toBe(202);
    expect(ctx.mailer.sent.length).toBe(before);
    const known = await post('/api/v1/auth/forgot-password', { email: 'reset@example.com' });
    expect(known.json()).toEqual(unknown.json());
    const token = tokenFrom(ctx.mailer.sent.at(-1)!.params.link!);
    const reset = await post('/api/v1/auth/reset-password', { token, password: 'brand new password' });
    expect(reset.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: user.cookie } });
    expect(me.statusCode).toBe(401);
    const reuse = await post('/api/v1/auth/reset-password', { token, password: 'brand new password 2' });
    expect(reuse.json().error.code).toBe('auth.token_used');
    const login = await post('/api/v1/auth/login', { email: 'reset@example.com', password: 'brand new password' });
    expect(login.statusCode).toBe(200);
  });

  it('rejects expired reset tokens', async () => {
    await createUser(ctx, 'expired@example.com');
    await post('/api/v1/auth/forgot-password', { email: 'expired@example.com' });
    const token = tokenFrom(ctx.mailer.sent.at(-1)!.params.link!);
    await ctx.db.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE purpose = 'reset_password'");
    const res = await post('/api/v1/auth/reset-password', { token, password: 'brand new password' });
    expect(res.json().error.code).toBe('auth.token_expired');
  });
});

describe('CSRF origin checks', () => {
  it('rejects cross-origin or origin-less mutations', async () => {
    const none = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'a@b.cd', password: 'x' } });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe('security.origin_mismatch');
    const evil = await post('/api/v1/auth/login', { email: 'a@b.cd', password: 'x' }, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    const sameSite = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(sameSite.statusCode).toBe(204);
  });
});

describe('profile optimistic locking (AT-51)', () => {
  it('requires If-Match and rejects stale revisions with 412', async () => {
    const user = await createUser(ctx, 'profile@example.com');
    const headers = { cookie: user.cookie, origin: ORIGIN };
    const missing = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: { locale: 'en' } });
    expect(missing.statusCode).toBe(428);
    const ok = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { ...headers, 'if-match': '"1"' }, payload: { locale: 'en' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    const stale = await ctx.app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { ...headers, 'if-match': '"1"' }, payload: { display_name: 'Other' } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe('resource.revision_conflict');
  });
});

describe('locale negotiation', () => {
  it('honours explicit locale, then Accept-Language, and localises error messages', async () => {
    const en = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(en.headers['content-language']).toBe('en');
    expect(en.json().error.message).toBe('Please sign in to continue.');
    const vi = await ctx.app.inject({ method: 'GET', url: '/api/v1/me?locale=vi', headers: { 'accept-language': 'en' } });
    expect(vi.headers['content-language']).toBe('vi');
    expect(vi.json().error.request_id).toMatch(/^req_/);
  });
});

describe('public catalog', () => {
  it('lists only published templates and exposes adapter support honestly', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?locale=en' });
    expect(list.json()).toEqual({ data: [], page: { next_cursor: null, has_more: false } });
    const config = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(config.json().data.adapters).toEqual([
      { code: 'static-html', status: 'supported' },
      { code: 'vite-static', status: 'not_implemented' },
      { code: 'next-standalone', status: 'not_implemented' },
      { code: 'node-http', status: 'not_implemented' },
    ]);
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/templates?limit=500' });
    expect(bad.statusCode).toBe(422);
  });
});
