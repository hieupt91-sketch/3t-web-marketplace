/**
 * M7: MFA (TOTP) + step-up, staff management (A24), shared-store rate
 * limiting, translations matrix (A22/W15), authenticated password change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';
import { totpCode } from '../../apps/api/src/lib/totp.ts';
import { checkDbRateLimit, PgRateLimitStore } from '../../apps/api/src/lib/rate-limit-store.ts';

let ctx: TestContext;
let owner: { id: string; cookie: string };
let owner2: { id: string; cookie: string };
let user: { id: string; cookie: string };
let staffUser: { id: string; cookie: string };
const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
  ctx = await createTestContext({});
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
  owner2 = await createUser(ctx, 'owner2@example.com', 'platform_owner');
  user = await createUser(ctx, 'user@example.com');
  staffUser = await createUser(ctx, 'staff@example.com');
});

afterAll(async () => {
  await ctx.close();
});

const as = (u: { cookie: string }) => ({ cookie: u.cookie, origin: ORIGIN });
async function login(email: string, password: string) {
  return ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
}
function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((c) => c.name === 'mp_session');
  return cookie ? `mp_session=${cookie.value}` : '';
}

describe('MFA and step-up', () => {
  it('enrolls TOTP, gates login behind a challenge, and consumes backup codes once', async () => {
    // Setup requires step-up.
    const noStepUp = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/mfa/setup', headers: as(user), payload: {} });
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe('auth.step_up_required');
    const stepUp = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: as(user), payload: { password: PASSWORD } });
    expect(stepUp.statusCode, stepUp.body).toBe(200);
    const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/mfa/setup', headers: as(user), payload: {} });
    expect(setup.statusCode, setup.body).toBe(201);
    const secret = setup.json().data.secret as string;
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/mfa/verify', headers: as(user), payload: { code: '000000' } });
    expect(wrong.statusCode).toBe(401);
    const verify = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/mfa/verify', headers: as(user), payload: { code: totpCode(secret) } });
    expect(verify.statusCode, verify.body).toBe(200);
    const backupCodes = verify.json().data.backup_codes as string[];
    expect(backupCodes.length).toBe(10);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/mfa', headers: as(user) });
    expect(status.json().data.enabled).toBe(true);

    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: as(user) });
    const challenged = await login('user@example.com', PASSWORD);
    expect(challenged.statusCode).toBe(200);
    expect(challenged.json().data.status).toBe('mfa_required');
    const token = challenged.json().data.challenge_token as string;
    const badCode = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/mfa-challenge', headers: { origin: ORIGIN }, payload: { challenge_token: token, code: '000000' } });
    expect(badCode.statusCode).toBe(401);
    const goodCode = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/mfa-challenge', headers: { origin: ORIGIN }, payload: { challenge_token: token, code: totpCode(secret) } });
    expect(goodCode.statusCode, goodCode.body).toBe(200);
    expect(sessionCookie(goodCode)).not.toBe('');

    // Backup code login: works once, then the same code is rejected.
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: sessionCookie(goodCode), origin: ORIGIN } });
    const challenged2 = await login('user@example.com', PASSWORD);
    const token2 = challenged2.json().data.challenge_token as string;
    const backupLogin = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/mfa-challenge', headers: { origin: ORIGIN }, payload: { challenge_token: token2, code: backupCodes[0]! } });
    expect(backupLogin.statusCode, backupLogin.body).toBe(200);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: sessionCookie(backupLogin), origin: ORIGIN } });
    const challenged3 = await login('user@example.com', PASSWORD);
    const token3 = challenged3.json().data.challenge_token as string;
    const reused = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/mfa-challenge', headers: { origin: ORIGIN }, payload: { challenge_token: token3, code: backupCodes[0]! } });
    expect(reused.statusCode).toBe(401);
  });

  it('changes password only with step-up and revokes other sessions', async () => {
    const fresh = await login('staff@example.com', PASSWORD);
    const freshCookie = sessionCookie(fresh);
    const noStepUp = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/password-change', headers: { cookie: freshCookie, origin: ORIGIN }, payload: { current_password: PASSWORD, new_password: 'new correct horse battery' } });
    expect(noStepUp.statusCode).toBe(403);
    const stepUp = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: { cookie: freshCookie, origin: ORIGIN }, payload: { password: PASSWORD } });
    expect(stepUp.statusCode, stepUp.body).toBe(200);
    const wrongCurrent = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/password-change', headers: { cookie: freshCookie, origin: ORIGIN }, payload: { current_password: 'wrong password here', new_password: 'new correct horse battery' } });
    expect(wrongCurrent.statusCode).toBe(401);
    const changed = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/password-change', headers: { cookie: freshCookie, origin: ORIGIN }, payload: { current_password: PASSWORD, new_password: 'new correct horse battery' } });
    expect(changed.statusCode, changed.body).toBe(200);
    const oldLogin = await login('staff@example.com', PASSWORD);
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await login('staff@example.com', 'new correct horse battery');
    expect(newLogin.statusCode).toBe(200);
    // The pre-change session (staffUser's original cookie) is revoked.
    const stale = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: as(staffUser) });
    expect(stale.statusCode).toBe(401);
    // Restore the password for later tests in this file.
    const newCookie = sessionCookie(newLogin);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: { cookie: newCookie, origin: ORIGIN }, payload: { password: 'new correct horse battery' } });
    const restored = await ctx.app.inject({ method: 'POST', url: '/api/v1/me/password-change', headers: { cookie: newCookie, origin: ORIGIN }, payload: { current_password: 'new correct horse battery', new_password: PASSWORD } });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});

describe('shared rate limiting and translations matrix', () => {
  it('counts across store instances against the same Postgres buckets', async () => {
    const StoreA = PgRateLimitStore.create(ctx.db);
    const storeA = new StoreA();
    const storeB = new StoreA();
    const key = 'test-shared-key';
    const incr = (store: PgRateLimitStore) =>
      new Promise<{ current: number; ttl: number }>((resolve, reject) =>
        store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), 60000),
      );
    const first = await incr(storeA);
    const second = await incr(storeB);
    expect(first.current).toBe(1);
    expect(second.current).toBe(2);
    const check = await checkDbRateLimit(ctx.db, 'partner:limit-test:mutation', 2, 60000);
    expect(check.allowed).toBe(true);
    await checkDbRateLimit(ctx.db, 'partner:limit-test:mutation', 2, 60000);
    const third = await checkDbRateLimit(ctx.db, 'partner:limit-test:mutation', 2, 60000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports missing/stale/published cells in the matrix (A22/W15)', async () => {
    const tpl = await ctx.db.query<{ id: string }>(`INSERT INTO templates (slug, owner_id, updated_at) VALUES ('m7-matrix', $1, now()) RETURNING id`, [owner.id]);
    await ctx.db.query(
      `INSERT INTO template_translations (template_id, locale, title, slug, status, source_revision, updated_at) VALUES ($1, 'vi', 'Mẫu', 'm7-matrix', 'published', 1, now() - interval '2 days')`,
      [tpl.rows[0]!.id],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/translations', headers: as(owner) });
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json().data as { template_id: string; locales: Record<string, { status: string }> }[]).find((r) => r.template_id === tpl.rows[0]!.id);
    expect(row).toBeDefined();
    expect(row!.locales.vi?.status).toBe('stale');
    expect(row!.locales.en?.status).toBe('missing');
  });
});

describe('staff management (A24)', () => {
  it('grants roles only up to the actor and never removes the last owner', async () => {
    // Owner steps up, then grants support to staffUser.
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: as(owner), payload: { password: PASSWORD } });
    const grant = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/staff/${staffUser.id}/roles`, headers: as(owner), payload: { role_code: 'support' } });
    expect(grant.statusCode, grant.body).toBe(201);
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/staff/${staffUser.id}`, headers: as(owner) });
    expect(detail.json().data.roles).toContain('support');
    // A limited staff-manager (staff:manage only) cannot grant accountant.
    await ctx.db.query(`INSERT INTO roles (code, description) VALUES ('staff_manager', 'test') ON CONFLICT (code) DO NOTHING`);
    await ctx.db.query(
      `INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'staff:manage' WHERE r.code = 'staff_manager' ON CONFLICT DO NOTHING`,
    );
    const manager = await createUser(ctx, 'manager@example.com');
    await ctx.db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'staff_manager'`, [manager.id]);
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: as(manager), payload: { password: PASSWORD } });
    const above = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/staff/${user.id}/roles`, headers: as(manager), payload: { role_code: 'accountant' } });
    expect(above.statusCode).toBe(403);
    expect(above.json().error.code).toBe('staff.grant_above_actor');
    const within = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/staff/${user.id}/roles`, headers: as(manager), payload: { role_code: 'staff_manager' } });
    expect(within.statusCode, within.body).toBe(201);
    // Last-owner guard: owner2 is the last platform_owner after owner1 is removed.
    await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: as(owner2), payload: { password: PASSWORD } });
    const removeFirst = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/admin/staff/${owner.id}/roles/platform_owner`, headers: as(owner2) });
    expect(removeFirst.statusCode, removeFirst.body).toBe(200);
    const removeLast = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/admin/staff/${owner2.id}/roles/platform_owner`, headers: as(owner2) });
    expect(removeLast.statusCode).toBe(409);
    expect(removeLast.json().error.code).toBe('staff.last_owner');
  });
});
