/**
 * M3 CMS content: platform pages, policy versions and contact requests (P05-P09, A27).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from '@3t/api/test-helpers';

let ctx: TestContext;
let owner: { id: string; cookie: string };

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await createUser(ctx, 'owner@example.com', 'platform_owner');
});
afterAll(async () => ctx.close());

const admin = () => ({ cookie: owner.cookie, origin: ORIGIN });

async function createPage(slug: string, kind: 'page' | 'help' = 'page') {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/pages', headers: admin(), payload: { slug, kind } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
async function putPageTranslation(id: string, locale: string, title: string, body = 'Nội dung', status = 'published') {
  return ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/content/pages/${id}/translations/${locale}`, headers: admin(), payload: { title, body, status } });
}
async function pageEtag(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/content/pages/${id}`, headers: admin() });
  return res.headers.etag as string;
}

describe('platform pages (P05/P06/P07)', () => {
  it('publishes a page and serves it localised with fallback', async () => {
    const id = await createPage('how-it-works');

    // Not published yet → public 404.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/pages/public/how-it-works' })).statusCode).toBe(404);

    // Publishing needs a published default (vi) translation.
    const noTr = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/content/pages/${id}/publish`, headers: { ...admin(), 'if-match': await pageEtag(id) } });
    expect(noTr.statusCode).toBe(409);
    expect(noTr.json().error.code).toBe('content.default_translation_required');

    expect((await putPageTranslation(id, 'vi', 'Cách mua', 'Bốn bước mua mẫu.')).statusCode).toBe(200);
    const published = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/content/pages/${id}/publish`, headers: { ...admin(), 'if-match': await pageEtag(id) } });
    expect(published.statusCode, published.body).toBe(200);

    const vi = await ctx.app.inject({ method: 'GET', url: '/api/v1/pages/public/how-it-works?locale=vi' });
    expect(vi.json().data).toMatchObject({ slug: 'how-it-works', title: 'Cách mua', translation_status: 'published', resolved_locale: 'vi' });
    // English requested, only vi published → fallback.
    const en = await ctx.app.inject({ method: 'GET', url: '/api/v1/pages/public/how-it-works?locale=en' });
    expect(en.json().data).toMatchObject({ translation_status: 'fallback', resolved_locale: 'vi', title: 'Cách mua' });
  });

  it('lists only published help pages with a title', async () => {
    const id = await createPage('getting-started', 'help');
    await putPageTranslation(id, 'vi', 'Bắt đầu');
    await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/content/pages/${id}/publish`, headers: { ...admin(), 'if-match': await pageEtag(id) } });
    const draft = await createPage('draft-help', 'help');
    await putPageTranslation(draft, 'vi', 'Nháp', 'x', 'draft');
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/pages/help?locale=vi' });
    const slugs = list.json().data.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('getting-started');
    expect(slugs).not.toContain('draft-help');
  });

  it('rejects duplicate slugs', async () => {
    await createPage('unique-page');
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/pages', headers: admin(), payload: { slug: 'unique-page' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('content.slug_taken');
  });
});

describe('policies (P08)', () => {
  it('publishes an immutable policy version and serves the current one', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/policies', headers: admin(), payload: { code: 'terms', version: '2026-10' } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id;
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/content/policies/${id}/translations/vi`, headers: admin(), payload: { title: 'Điều khoản', body: 'Nội dung điều khoản.', status: 'published' } });
    const published = await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/content/policies/${id}/publish`, headers: admin(), payload: { effective_at: '2026-10-01T00:00:00Z' } });
    expect(published.statusCode, published.body).toBe(200);

    const current = await ctx.app.inject({ method: 'GET', url: '/api/v1/policies/terms?locale=vi' });
    expect(current.json().data).toMatchObject({ code: 'terms', version: '2026-10', title: 'Điều khoản', effective_at: '2026-10-01T00:00:00.000Z' });
    const byVersion = await ctx.app.inject({ method: 'GET', url: '/api/v1/policies/terms/versions/2026-10?locale=vi' });
    expect(byVersion.json().data.version).toBe('2026-10');

    // A published policy body is immutable at the DB level.
    await expect(ctx.db.query("UPDATE policy_versions SET body_hash = 'x' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    // A future-dated version is not yet the current policy.
    const future = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/policies', headers: admin(), payload: { code: 'terms', version: '2099-01' } });
    const fid = future.json().data.id;
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/content/policies/${fid}/translations/vi`, headers: admin(), payload: { title: 'Điều khoản mới', body: 'Sau này.', status: 'published' } });
    await ctx.app.inject({ method: 'POST', url: `/api/v1/admin/content/policies/${fid}/publish`, headers: admin(), payload: { effective_at: '2099-01-01T00:00:00Z' } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/policies/terms?locale=vi' })).json().data.version).toBe('2026-10');
  });
});

describe('contact requests (P09)', () => {
  it('accepts a valid request, flags the honeypot, and never leaks whether it was spam', async () => {
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact-requests', headers: { origin: ORIGIN }, payload: { name: 'Lan', email: 'lan@example.com', body: 'Xin tư vấn mẫu nhà hàng.', consent: true } });
    expect(ok.statusCode).toBe(202);
    const bot = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact-requests', headers: { origin: ORIGIN }, payload: { name: 'Bot', email: 'bot@example.com', body: 'spam', consent: true, website: 'http://spam.example' } });
    expect(bot.statusCode).toBe(202);
    expect(bot.json()).toEqual(ok.json());

    const inbox = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/content/contact-requests', headers: admin() });
    const rows = inbox.json().data as { email: string; spam_status: string }[];
    expect(rows.find((r) => r.email === 'lan@example.com')?.spam_status).toBe('ok');
    expect(rows.find((r) => r.email === 'bot@example.com')?.spam_status).toBe('suspected');
  });

  it('validates email and consent', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact-requests', headers: { origin: ORIGIN }, payload: { name: 'X', email: 'not-an-email', body: 'hi', consent: false } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.field_errors.map((f: { field: string }) => f.field)).toEqual(expect.arrayContaining(['email', 'consent']));
  });
});

describe('content permissions', () => {
  it('forbids content and policy management without the right role', async () => {
    const support = await createUser(ctx, `support-${randomUUID().slice(0, 8)}@example.com`, 'support');
    const page = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/pages', headers: { cookie: support.cookie, origin: ORIGIN }, payload: { slug: 'x-page' } });
    expect(page.statusCode).toBe(403);
    const policy = await ctx.app.inject({ method: 'POST', url: '/api/v1/admin/content/policies', headers: { cookie: support.cookie, origin: ORIGIN }, payload: { code: 'x', version: '1' } });
    expect(policy.statusCode).toBe(403);
    // Support role may read the contact inbox.
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/content/contact-requests', headers: { cookie: support.cookie } })).statusCode).toBe(200);
  });
});
