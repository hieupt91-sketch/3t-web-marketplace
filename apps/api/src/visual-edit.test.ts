import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Visual editor for hosted static sites (migration 0046): the second
 *  door to the SAME one-time setup right the order form spends (0045).
 *  These tests cover the API half — eligibility on the site detail,
 *  session minting (candidates = twin seed ∩ static HTML, token stored
 *  hashed), and the lock interplay in both directions. The router half
 *  (injection/finalize) and the worker half (backup + rewrite) have
 *  their own suites. */
let ctx: TestContext;
let ownerCookie: string;
const TERMS = 'terms-2026-10';
const HUB_KEY = 'visual-edit-hub-key';

const get = (url: string, cookie?: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });

async function setSetting(key: string, value: unknown): Promise<void> {
  await ctx.db.query(
    `INSERT INTO settings (key, value_json) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    [key, JSON.stringify(value)],
  );
}

async function makeTemplate(slug: string, adapter: string): Promise<{ id: string; versionId: string }> {
  const owner = await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE email_normalized = 've-owner@example.com'");
  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ($1, $2, 'published') RETURNING id",
    [slug, owner.rows[0]!.id],
  );
  const id = tpl.rows[0]!.id;
  await ctx.db.query(
    'INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, \'vi\', $2, $3, \'published\')',
    [id, `Mẫu ${slug}`, slug],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ($1, $2, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    [`test/${slug}`, randomBytes(32).toString('hex')],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, $5::jsonb, $2, $3, $4, $4, 'published') RETURNING id`,
    [id, adapter, randomBytes(32).toString('hex'), artifact.rows[0]!.id, JSON.stringify({ adapter })],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [id, version.rows[0]!.id]);
  return { id, versionId: version.rows[0]!.id };
}

async function writeArtifactFile(objectKey: string, rel: string, content: string): Promise<void> {
  const full = join(ctx.store.pathFor(objectKey), rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function makePlan(templateId: string, code: string, mode: 'hosted' | 'selfhost', amount: number): Promise<string> {
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, $2, $3, '{"vi":"Gói","en":"Plan"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId, code, mode],
  );
  await ctx.db.query(
    'INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, \'VND\', $2, $3, now() - interval \'1 day\')',
    [plan.rows[0]!.id, amount, mode === 'hosted' ? 'monthly' : 'one_time'],
  );
  return plan.rows[0]!.id;
}

async function settle(cookie: string, quoteId: string, amount: number): Promise<string> {
  const o = await post('/api/v1/orders', { quote_id: quoteId, terms_version: TERMS }, cookie, { 'idempotency-key': randomUUID() });
  expect(o.statusCode, o.body).toBe(201);
  const orderId = o.json().data.id as string;
  const s = await post(`/api/v1/orders/${orderId}/payment-sessions`, {}, cookie);
  expect(s.statusCode, s.body).toBe(201);
  const code = s.json().data.instructions.content_code as string;
  const hook = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/bank_transfer',
    headers: { authorization: `Apikey ${HUB_KEY}` },
    payload: { id: Math.floor(Math.random() * 900_000_000) + 100_000_000, code, transferType: 'in', transferAmount: amount },
  });
  expect(hook.statusCode, hook.body).toBe(200);
  expect(hook.json().outcome).toBe('processed');
  return orderId;
}

/** Buy (quote → pay) and return the fresh order id + entitlement id. */
async function buy(cookie: string, templateId: string, planId: string, opts: { installation?: boolean; amount: number }): Promise<{ orderId: string; entitlementId: string }> {
  const q = await post('/api/v1/quotes', { plan_id: planId, template_id: templateId, ...(opts.installation ? { installation: true } : {}) }, cookie);
  expect(q.statusCode, q.body).toBe(201);
  const orderId = await settle(cookie, q.json().data.id, opts.amount);
  const ents = await get('/api/v1/me/entitlements', cookie);
  const mine = (ents.json().data as { id: string; status: string; template: { id: string } }[])
    .filter((e) => e.template.id === templateId)
    .at(-1);
  expect(mine, 'entitlement for the purchase').toBeTruthy();
  return { orderId, entitlementId: mine!.id };
}

async function makeSite(ownerId: string, entitlementId: string, versionId: string, subdomain: string, runtimeKind: 'static' | 'runtime'): Promise<string> {
  const site = await ctx.db.query<{ id: string }>(
    `INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, status, runtime_kind, runtime_port)
     VALUES ($1, $2, $3, 'Site Kiểm Tra', $4, 'active', $5, 4310) RETURNING id`,
    [ownerId, entitlementId, versionId, subdomain, runtimeKind],
  );
  return site.rows[0]!.id;
}

const SEED = {
  site: {
    name: { vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' },
    phone: '0967 136 099',
    email: 'lien-he@vi-du.vn',
  },
  hero: { image: 'images/hero.jpg', headline: { vi: 'Phụ tùng chính hãng', en: 'Genuine parts' } },
  menu: { items: [{ name: { vi: 'Lọc dầu động cơ', en: 'Engine oil filter' }, price: '250.000₫' }] },
  about: { text: { vi: 'Chuỗi vắng mặt không có trong HTML', en: 'Absent string' } },
};
const STATIC_HTML = `<!doctype html><html lang="vi"><head><title>Phụ Tùng Ô Tô Trường Sơn</title></head><body>
<h1>Phụ Tùng Ô Tô Trường Sơn</h1>
<p data-en="Truong Son Auto Parts">Phụ Tùng Ô Tô Trường Sơn</p>
<p>Hotline: 0967 136 099</p>
<img src="images/hero.jpg" alt="Ảnh bìa">
<div class="item"><h3>Lọc dầu động cơ</h3><span>250.000₫</span></div>
</body></html>`;
const STATIC_HTML_2 = `<!doctype html><html lang="vi"><body><footer>Gọi ngay: 0967 136 099</footer></body></html>`;

let staticTpl: { id: string; versionId: string };
let twinTpl: { id: string; versionId: string };
let staticHostedPlanId: string;
let staticSelfhostPlanId: string;
let twinHostedPlanId: string;

interface BuyerFlow { id: string; cookie: string; orderId: string; siteId: string }
let mainFlow: BuyerFlow;
let formFirstFlow: BuyerFlow;
let editorFirstFlow: BuyerFlow;

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 've-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie);

  staticTpl = await makeTemplate('visual-edit-1', 'static-html');
  twinTpl = await makeTemplate('visual-edit-1-dong', 'node-http');
  await writeArtifactFile('test/visual-edit-1', 'index.html', STATIC_HTML);
  await writeArtifactFile('test/visual-edit-1', 'second.html', STATIC_HTML_2);
  await writeArtifactFile('test/visual-edit-1-dong', 'public/seed.json', JSON.stringify(SEED));

  staticHostedPlanId = await makePlan(staticTpl.id, 'hosted', 'hosted', 499000);
  staticSelfhostPlanId = await makePlan(staticTpl.id, 'selfhost', 'selfhost', 199999);
  twinHostedPlanId = await makePlan(twinTpl.id, 'hosted', 'hosted', 499000);
  await setSetting('service.installation', { enabled: true, amount_minor: 300000 });
  const bank = await post('/api/v1/admin/settings/payment', {
    enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
    account_number: '0123456789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_KEY,
  }, ownerCookie);
  expect(bank.statusCode, bank.body).toBe(200);

  const mkFlow = async (email: string, subdomain: string): Promise<BuyerFlow> => {
    const buyer = await createUser(ctx, email);
    const { orderId, entitlementId } = await buy(buyer.cookie, staticTpl.id, staticHostedPlanId, { installation: true, amount: 799000 });
    const siteId = await makeSite(buyer.id, entitlementId, staticTpl.versionId, subdomain, 'static');
    return { id: buyer.id, cookie: buyer.cookie, orderId, siteId };
  };
  mainFlow = await mkFlow('ve-a@example.com', 've-main');
  formFirstFlow = await mkFlow('ve-form@example.com', 've-form');
  editorFirstFlow = await mkFlow('ve-editor@example.com', 've-editor');
});
afterAll(async () => ctx.close());

describe('site detail eligibility', () => {
  it('reports visual_edit available for an eligible hosted static site', async () => {
    const res = await get(`/api/v1/sites/${mainFlow.siteId}`, mainFlow.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.visual_edit).toEqual({ available: true, reason: 'ok' });
  });

  it('reports no_setup_task for a static site bought without the installation package', async () => {
    const buyer = await createUser(ctx, 've-nosetup@example.com');
    const { entitlementId } = await buy(buyer.cookie, staticTpl.id, staticSelfhostPlanId, { amount: 199999 });
    const siteId = await makeSite(buyer.id, entitlementId, staticTpl.versionId, 've-nosetup', 'static');
    const res = await get(`/api/v1/sites/${siteId}`, buyer.cookie);
    expect(res.json().data.visual_edit).toEqual({ available: false, reason: 'no_setup_task' });
    const mint = await post(`/api/v1/sites/${siteId}/visual-edit/session`, {}, buyer.cookie);
    expect(mint.statusCode, mint.body).toBe(404);
  });

  it('hides visual_edit entirely for dynamic sites and refuses their mint', async () => {
    const buyer = await createUser(ctx, 've-dynamic@example.com');
    const { entitlementId } = await buy(buyer.cookie, twinTpl.id, twinHostedPlanId, { installation: true, amount: 799000 });
    const siteId = await makeSite(buyer.id, entitlementId, twinTpl.versionId, 've-dynamic', 'runtime');
    const res = await get(`/api/v1/sites/${siteId}`, buyer.cookie);
    expect(res.json().data.visual_edit).toBeNull();
    const mint = await post(`/api/v1/sites/${siteId}/visual-edit/session`, {}, buyer.cookie);
    expect(mint.statusCode, mint.body).toBe(404);
  });
});

describe('session minting', () => {
  it('mints a session: candidates are twin seed ∩ static HTML; the token is stored hashed only', async () => {
    const res = await post(`/api/v1/sites/${mainFlow.siteId}/visual-edit/session`, {}, mainFlow.cookie);
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { edit_url: string; candidates_count: number };
    expect(data.candidates_count).toBe(5);
    expect(data.edit_url).toContain('ve-main');
    expect(data.edit_url).toContain('__3t_edit/enter?token=');
    const token = data.edit_url.split('token=')[1]!;
    expect(token.length).toBeGreaterThanOrEqual(40);

    const rows = await ctx.db.query<{ token_hash: string; candidates_json: { id: string }[]; task_id: string; consumed_at: Date | null }>(
      'SELECT token_hash, candidates_json, task_id, consumed_at FROM site_edit_sessions WHERE site_id = $1',
      [mainFlow.siteId],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.token_hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(rows.rows[0]!.token_hash).not.toContain(token);
    expect(rows.rows[0]!.consumed_at).toBeNull();
    const ids = rows.rows[0]!.candidates_json.map((c) => c.id).sort();
    // site.email (absent from HTML), hero.headline and about.text
    // (absent) are filtered out by the presence check.
    expect(ids).toEqual(['hero.image', 'menu.items.0.name', 'menu.items.0.price', 'site.name', 'site.phone']);

    const audit = await ctx.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_logs WHERE action = 'site.visual_edit_session_created' AND resource_id = $1",
      [mainFlow.siteId],
    );
    expect(audit.rows[0]!.n).toBe('1');
  });

  it('is owner-only: another buyer cannot mint or even see the site', async () => {
    const stranger = await createUser(ctx, 've-stranger@example.com');
    const mint = await post(`/api/v1/sites/${mainFlow.siteId}/visual-edit/session`, {}, stranger.cookie);
    expect(mint.statusCode).toBe(404);
  });
});

describe('lock interplay — form door first', () => {
  it('after the form is submitted, minting 409s and the detail reports already_submitted', async () => {
    const form = await post(`/api/v1/orders/${formFirstFlow.orderId}/setup-info`, { business_name: 'Minh Phát Qua Form' }, formFirstFlow.cookie);
    expect(form.statusCode, form.body).toBe(201);
    const detail = await get(`/api/v1/sites/${formFirstFlow.siteId}`, formFirstFlow.cookie);
    expect(detail.json().data.visual_edit).toEqual({ available: false, reason: 'already_submitted' });
    const mint = await post(`/api/v1/sites/${formFirstFlow.siteId}/visual-edit/session`, {}, formFirstFlow.cookie);
    expect(mint.statusCode, mint.body).toBe(409);
    expect(mint.json().error.code).toBe('setup_info.already_submitted');
  });
});

describe('lock interplay — editor door first', () => {
  it('a task claimed by the visual editor (router claim shape) makes the form POST 409', async () => {
    // Exactly what the router's finalize writes when it wins the race.
    const claim = await ctx.db.query<{ id: string }>(
      `UPDATE service_tasks SET setup_info_json = $2::jsonb, setup_info_submitted_at = now()
       WHERE order_id = $1 AND kind = 'installation' AND setup_info_submitted_at IS NULL RETURNING id`,
      [editorFirstFlow.orderId, JSON.stringify({ source: 'visual_editor', session_id: '00000000-0000-0000-0000-000000000000', changes: [{ field: 'site.name', vi_from: 'Phụ Tùng Ô Tô Trường Sơn', vi_to: 'Minh Phát' }] })],
    );
    expect(claim.rows.length).toBe(1);
    const form = await post(`/api/v1/orders/${editorFirstFlow.orderId}/setup-info`, { business_name: 'Trễ Rồi' }, editorFirstFlow.cookie);
    expect(form.statusCode, form.body).toBe(409);
    expect(form.json().error.code).toBe('setup_info.already_submitted');
    const order = await get(`/api/v1/orders/${editorFirstFlow.orderId}`, editorFirstFlow.cookie);
    expect(order.json().data.setup_info.submitted).toBe(true);
    expect(order.json().data.setup_info.data.source).toBe('visual_editor');
    const detail = await get(`/api/v1/sites/${editorFirstFlow.siteId}`, editorFirstFlow.cookie);
    expect(detail.json().data.visual_edit).toEqual({ available: false, reason: 'already_submitted' });
  });
});
