import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@3t/core';
import { createTestContext, createUser, ORIGIN, stepUp, type TestContext } from './test-helpers.ts';
import { totpCode } from './lib/totp.ts';

/**
 * Wave-3 audit fixes (integration): GitHub webhook HMAC over the raw
 * body (L-01), session absolute/idle caps (L-03), MFA backup codes —
 * scrypt storage, legacy codes still work, single use (L-05), the
 * partner settings schema tightening (I-02) and API framing headers
 * (UI-INFO-01).
 */
const GH_SECRET = 'wave3-gh-secret';
const PASSWORD = 'correct horse battery staple';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({ githubWebhookSecret: GH_SECRET });
});
afterAll(async () => ctx.close());

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie = '', extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...extra } });

/* --------------------------- L-01: raw-body HMAC --------------------------- */

describe('GitHub webhook raw-body HMAC (L-01)', () => {
  // Whitespace and spacing make the raw bytes differ from any
  // JSON.stringify(JSON.parse(raw)) re-serialisation.
  const RAW = '{ "ref" : "refs/heads/main",  "repository" : { "full_name" : "acme/widgets" }, "head_commit" : { "id" : "abc123" } }';
  const sign = (body: string) => `sha256=${createHmac('sha256', GH_SECRET).update(body, 'utf8').digest('hex')}`;
  const call = (signature: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports/github-webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': randomUUID(),
        'x-github-event': 'push',
      },
      payload: RAW,
    });

  it('accepts a signature over the exact raw bytes', async () => {
    const res = await call(sign(RAW));
    expect(res.statusCode, res.body).toBe(200);
    // No prior import for acme/widgets → verified, then ignored.
    expect(res.json().outcome).toBe('ignored');
  });

  it('rejects a signature over the re-serialised body', async () => {
    const reserialized = JSON.stringify(JSON.parse(RAW));
    expect(reserialized).not.toBe(RAW);
    const res = await call(sign(reserialized));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('github.webhook_invalid');
  });

  it('still parses normal JSON bodies on other routes', async () => {
    const user = await createUser(ctx, 'wave3-json@example.com');
    const res = await get('/api/v1/me', user.cookie);
    expect(res.statusCode, res.body).toBe(200);
  });
});

/* --------------------------- L-03: session caps --------------------------- */

describe('session lifetime policy (L-03)', () => {
  async function onlySession(userId: string) {
    const { rows } = await ctx.db.query<{ id: string; last_seen_at: Date; revoked_at: Date | null }>(
      'SELECT id, last_seen_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
    return rows[0]!;
  }

  it('rejects and revokes a staff session idle past 12 h', async () => {
    const staff = await createUser(ctx, 'wave3-staff-idle@example.com', 'platform_owner');
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = $1", [staff.id]);
    const res = await get('/api/v1/me', staff.cookie);
    expect(res.statusCode, res.body).toBe(401);
    expect((await onlySession(staff.id)).revoked_at).not.toBeNull();
  });

  it('rejects a staff session past the 72 h absolute cap even when active', async () => {
    const staff = await createUser(ctx, 'wave3-staff-abs@example.com', 'platform_owner');
    await ctx.db.query(
      "UPDATE sessions SET created_at = now() - interval '73 hours', last_seen_at = now(), expires_at = now() + interval '2 days' WHERE user_id = $1",
      [staff.id],
    );
    const res = await get('/api/v1/me', staff.cookie);
    expect(res.statusCode, res.body).toBe(401);
    expect((await onlySession(staff.id)).revoked_at).not.toBeNull();
  });

  it('keeps a buyer session alive at 47 h idle', async () => {
    const buyer = await createUser(ctx, 'wave3-buyer-47@example.com');
    await ctx.db.query(
      "UPDATE sessions SET created_at = now() - interval '47 hours', last_seen_at = now() - interval '47 hours' WHERE user_id = $1",
      [buyer.id],
    );
    const res = await get('/api/v1/me', buyer.cookie);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('rejects and revokes a buyer session idle past 48 h', async () => {
    const buyer = await createUser(ctx, 'wave3-buyer-49@example.com');
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '49 hours' WHERE user_id = $1", [buyer.id]);
    const res = await get('/api/v1/me', buyer.cookie);
    expect(res.statusCode, res.body).toBe(401);
    expect((await onlySession(buyer.id)).revoked_at).not.toBeNull();
  });

  it('refreshes last_seen_at only outside the 5-minute throttle', async () => {
    const buyer = await createUser(ctx, 'wave3-throttle@example.com');
    // 2 minutes old: inside the throttle — a request must not move it.
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '2 minutes' WHERE user_id = $1", [buyer.id]);
    const before = (await onlySession(buyer.id)).last_seen_at.getTime();
    expect((await get('/api/v1/me', buyer.cookie)).statusCode).toBe(200);
    expect((await onlySession(buyer.id)).last_seen_at.getTime()).toBe(before);
    // 10 minutes old: outside the throttle — the same request refreshes it.
    await ctx.db.query("UPDATE sessions SET last_seen_at = now() - interval '10 minutes' WHERE user_id = $1", [buyer.id]);
    expect((await get('/api/v1/me', buyer.cookie)).statusCode).toBe(200);
    const after = (await onlySession(buyer.id)).last_seen_at.getTime();
    expect(Date.now() - after).toBeLessThan(60_000);
  });

  it('caps expires_at at creation: 72 h for role holders, 168 h for buyers', async () => {
    const staff = await createUser(ctx, 'wave3-staff-ttl@example.com', 'platform_owner');
    const buyer = await createUser(ctx, 'wave3-buyer-ttl@example.com');
    const hours = async (userId: string) => {
      const { rows } = await ctx.db.query<{ h: string }>(
        'SELECT extract(epoch FROM (expires_at - created_at)) / 3600 AS h FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [userId],
      );
      return Number(rows[0]!.h);
    };
    expect(await hours(staff.id)).toBeCloseTo(72, 0);
    expect(await hours(buyer.id)).toBeCloseTo(168, 0);
  });
});

/* --------------------------- L-05: MFA backup codes --------------------------- */

describe('MFA backup codes (L-05)', () => {
  const EMAIL = 'wave3-mfa@example.com';
  let backupCodes: string[] = [];

  async function loginChallenge(): Promise<string> {
    const res = await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('mfa_required');
    return res.json().data.challenge_token as string;
  }
  const challenge = (token: string, code: string) => post('/api/v1/auth/mfa-challenge', { challenge_token: token, code });

  beforeAll(async () => {
    const user = await createUser(ctx, EMAIL);
    await stepUp(ctx, user.cookie);
    const setup = await post('/api/v1/me/mfa/setup', {}, user.cookie);
    expect(setup.statusCode, setup.body).toBe(201);
    const secret = setup.json().data.secret as string;
    const verify = await post('/api/v1/me/mfa/verify', { code: totpCode(secret) }, user.cookie);
    expect(verify.statusCode, verify.body).toBe(200);
    backupCodes = verify.json().data.backup_codes as string[];
  });

  it('issues 10 codes of 80 bits, stored as s1$ scrypt hashes', async () => {
    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes) expect(code.replace(/-/g, '')).toHaveLength(20);
    const { rows } = await ctx.db.query<{ backup_codes_hash: string[] }>(
      'SELECT backup_codes_hash FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)',
      [EMAIL],
    );
    expect(rows[0]!.backup_codes_hash).toHaveLength(10);
    for (const stored of rows[0]!.backup_codes_hash) expect(stored.startsWith('s1$scrypt$')).toBe(true);
  });

  it('accepts a new backup code once, then never again', async () => {
    const first = await challenge(await loginChallenge(), backupCodes[0]!);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.status).toBe('signed_in');
    const reuse = await challenge(await loginChallenge(), backupCodes[0]!);
    expect(reuse.statusCode, reuse.body).toBe(401);
  });

  it('still accepts a legacy sha256-stored code and consumes it', async () => {
    const legacyCode = 'ABCDEF0123';
    await ctx.db.query(
      'UPDATE user_mfa SET backup_codes_hash = $2 WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)',
      [EMAIL, [hashToken(legacyCode).toString('hex')]],
    );
    const res = await challenge(await loginChallenge(), legacyCode);
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await ctx.db.query<{ backup_codes_hash: string[] }>(
      'SELECT backup_codes_hash FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)',
      [EMAIL],
    );
    expect(rows[0]!.backup_codes_hash).toHaveLength(0);
    const reuse = await challenge(await loginChallenge(), legacyCode);
    expect(reuse.statusCode, reuse.body).toBe(401);
  });

  it('rejects a wrong backup code', async () => {
    const res = await challenge(await loginChallenge(), 'FFFFFFFFFF');
    expect(res.statusCode, res.body).toBe(401);
  });
});

/* --------------------------- I-02 + UI-INFO-01 --------------------------- */

describe('partner settings schema (I-02) and API framing headers (UI-INFO-01)', () => {
  it('rejects unknown fields on POST /partner/settings, accepts the known ones', async () => {
    const user = await createUser(ctx, 'wave3-partner@example.com');
    await ctx.db.query(
      "INSERT INTO partner_accounts (user_id, code, display_name, status) VALUES ($1, 'WAVE3P', 'Wave3 Partner', 'active')",
      [user.id],
    );
    await stepUp(ctx, user.cookie);
    const bad = await post('/api/v1/partner/settings', { locale: 'en', backdoor: 'x' }, user.cookie);
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.body).toContain('unknown_field');
    const ok = await post('/api/v1/partner/settings', { locale: 'en', timezone: 'Asia/Ho_Chi_Minh', return_domains: ['example.com'] }, user.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('sends CSP + X-Frame-Options on API responses', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
