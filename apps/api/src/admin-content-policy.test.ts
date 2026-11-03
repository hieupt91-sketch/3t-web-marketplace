import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/** Policy versions (admin-content): translations are edited while a
 *  version is a draft, then the version is published with a body hash.
 *  Editing a translation of an already-published version would rewrite
 *  live legal text under its publish-time hash, so the PUT must refuse
 *  with 409 policy.version_published (M3). */
let ctx: TestContext;
let ownerCookie: string;

const post = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });
const put = (url: string, payload: unknown, cookie: string) =>
  ctx.app.inject({ method: 'PUT', url, payload: payload as object, headers: { origin: ORIGIN, cookie } });

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'policy-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
});
afterAll(async () => ctx.close());

describe('policy version translations', () => {
  it('a published version refuses translation edits with 409; a draft accepts them', async () => {
    const created = await post('/api/v1/admin/content/policies', { code: 'terms-m3', version: '2026-11' }, ownerCookie);
    expect(created.statusCode, created.body).toBe(201);
    const versionId = created.json().data.id as string;

    const draftEdit = await put(`/api/v1/admin/content/policies/${versionId}/translations/vi`, {
      title: 'Điều khoản', body: 'Nội dung điều khoản.', status: 'published',
    }, ownerCookie);
    expect(draftEdit.statusCode, draftEdit.body).toBe(200);

    const published = await post(`/api/v1/admin/content/policies/${versionId}/publish`, {}, ownerCookie);
    expect(published.statusCode, published.body).toBe(200);

    const lateEdit = await put(`/api/v1/admin/content/policies/${versionId}/translations/vi`, {
      title: 'Điều khoản (sửa lén)', body: 'Nội dung khác hẳn.', status: 'published',
    }, ownerCookie);
    expect(lateEdit.statusCode, lateEdit.body).toBe(409);
    expect(lateEdit.body).toContain('policy.version_published');

    // The live text is untouched by the refused edit.
    const stored = await ctx.db.query<{ title: string; body: string }>(
      "SELECT title, body FROM policy_translations WHERE policy_version_id = $1 AND locale = 'vi'",
      [versionId],
    );
    expect(stored.rows[0]).toMatchObject({ title: 'Điều khoản', body: 'Nội dung điều khoản.' });
  });
});
