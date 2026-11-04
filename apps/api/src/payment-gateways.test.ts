import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Gateway payments (VNPay + MoMo): owner merchant settings, redirect
 *  sessions, and signed IPN settlement — checked against independent
 *  re-implementations of the vendors' signing schemes. */
let ctx: TestContext;
let ownerCookie: string;
let buyerCookie: string;
let templateId: string;
let planId: string;
const TERMS = 'terms-2026-10';
const VNP_SECRET = 'VNPAYTESTSECRET0123456789ABCDEF';
const MOMO_SECRET = 'MOMOTESTSECRETKEY0123456789';
const PAYOS_CLIENT_ID = 'payos-client-id-test';
const PAYOS_API_KEY = 'PAYOSAPIKEYTEST0123456789';
const PAYOS_CHECKSUM = 'PAYOSCHECKSUMKEY0123456789ABCDEF0123';
const PAYOS_LINK_ID = 'payoslinktest123';

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'gw-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // wave-1: payment settings + manual confirm require step-up
  const buyer = await createUser(ctx, 'gw-buyer@example.com');
  buyerCookie = buyer.cookie;

  const tpl = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('gw-pay-1', $1, 'published') RETURNING id",
    [owner.id],
  );
  templateId = tpl.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO template_translations (template_id, locale, title, slug, status) VALUES ($1, 'vi', 'Mẫu gw', 'gw-pay-1', 'published')",
    [templateId],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/gw-pay-1', $1, 4, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['d'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{}'::jsonb, 'static-html', $2, $3, $3, 'published') RETURNING id`,
    [templateId, 'd'.repeat(64), artifact.rows[0]!.id],
  );
  await ctx.db.query('UPDATE templates SET published_version_id = $2 WHERE id = $1', [templateId, version.rows[0]!.id]);
  const plan = await ctx.db.query<{ id: string }>(
    `INSERT INTO plans (template_id, code, deployment_mode, name_json, limits_json, status)
     VALUES ($1, 'selfhost', 'selfhost', '{"vi":"Gói","en":"Plan"}'::jsonb, '{}'::jsonb, 'active') RETURNING id`,
    [templateId],
  );
  planId = plan.rows[0]!.id;
  await ctx.db.query(
    "INSERT INTO plan_prices (plan_id, currency, amount_minor, interval, effective_from) VALUES ($1, 'VND', 499000, 'one_time', now() - interval '1 day')",
    [planId],
  );
});
afterAll(async () => ctx.close());

const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });
const post = (url: string, payload: unknown, cookie: string, extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, cookie, ...extra } });

async function newOrder(): Promise<string> {
  const q = await post('/api/v1/quotes', { plan_id: planId, template_id: templateId }, buyerCookie);
  expect(q.statusCode, q.body).toBe(201);
  const o = await post('/api/v1/orders', { quote_id: q.json().data.id, terms_version: TERMS }, buyerCookie, { 'idempotency-key': randomUUID() });
  expect(o.statusCode, o.body).toBe(201);
  return o.json().data.id as string;
}

function vnpaySign(params: Record<string, string>): string {
  const data = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&');
  return createHmac('sha512', VNP_SECRET).update(data, 'utf-8').digest('hex');
}

describe('VNPay', () => {
  let orderId: string;
  let txnRef: string;

  it('stores merchant settings without ever returning the secret', async () => {
    expect((await get('/api/v1/admin/settings/payment-vnpay', buyerCookie)).statusCode).toBe(403);
    const incomplete = await post('/api/v1/admin/settings/payment-vnpay', { enabled: true, tmn_code: 'TESTSHOP' }, ownerCookie);
    expect(incomplete.statusCode).toBe(422);
    const res = await post('/api/v1/admin/settings/payment-vnpay', { enabled: true, tmn_code: 'TESTSHOP', secret_key: VNP_SECRET, sandbox: true }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: true, tmn_code: 'TESTSHOP', secret_configured: true, sandbox: true });
    expect(res.body).not.toContain(VNP_SECRET);
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(pub.json().data.payment.vnpay).toBe(true);
  });

  it('creates a signed sandbox redirect session', async () => {
    orderId = await newOrder();
    const res = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'vnpay' }, buyerCookie);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.provider).toBe('vnpay');
    expect(res.json().data.sandbox).toBe(true);
    txnRef = res.json().data.provider_ref;
    expect(txnRef).toMatch(/^VP[0-9A-F]{12}$/);
    const url = new URL(res.json().data.pay_url);
    expect(url.origin).toBe('https://sandbox.vnpayment.vn');
    expect(url.searchParams.get('vnp_TxnRef')).toBe(txnRef);
    expect(url.searchParams.get('vnp_Amount')).toBe('49900000');
  });

  it('settles from a signed IPN, answers duplicates with RspCode 02, rejects bad signatures with 97', async () => {
    const params: Record<string, string> = {
      vnp_Amount: '49900000', vnp_BankCode: 'NCB', vnp_OrderInfo: 'webmaket order payment',
      vnp_PayDate: '20261030230000', vnp_ResponseCode: '00', vnp_TmnCode: 'TESTSHOP',
      vnp_TransactionNo: '14999999', vnp_TransactionStatus: '00', vnp_TxnRef: txnRef,
    };
    const query = `${Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&')}&vnp_SecureHash=${vnpaySign(params)}`;
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/payments/webhooks/vnpay?${query}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ RspCode: '00' });
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
    const dup = await ctx.app.inject({ method: 'GET', url: `/api/v1/payments/webhooks/vnpay?${query}` });
    expect(dup.json()).toMatchObject({ RspCode: '02' });
    const bad = await ctx.app.inject({ method: 'GET', url: `/api/v1/payments/webhooks/vnpay?${query.slice(0, -8)}deadbeef` });
    expect(bad.json()).toMatchObject({ RspCode: '97' });
  });
});

describe('MoMo', () => {
  let orderId: string;
  let orderRef: string;

  it('stores merchant settings without ever returning the secret key', async () => {
    const res = await post('/api/v1/admin/settings/payment-momo', { enabled: true, partner_code: 'MOMOTEST', access_key: 'AKTEST123', secret_key: MOMO_SECRET, sandbox: true }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: true, partner_code: 'MOMOTEST', secret_configured: true });
    expect(res.body).not.toContain(MOMO_SECRET);
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(pub.json().data.payment.momo).toBe(true);
  });

  it('creates a session through the signed create call', async () => {
    orderId = await newOrder();
    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return { json: async () => ({ resultCode: 0, payUrl: 'https://test-payment.momo.vn/pay/xyz' }) };
    });
    try {
      const res = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'momo' }, buyerCookie);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data.pay_url).toBe('https://test-payment.momo.vn/pay/xyz');
      orderRef = res.json().data.provider_ref;
      expect(orderRef).toMatch(/^MM[0-9A-F]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
    const body = captured as unknown as Record<string, string>;
    const raw = `accessKey=AKTEST123&amount=499000&extraData=&ipnUrl=${body.ipnUrl}&orderId=${orderRef}&orderInfo=webmaket order payment&partnerCode=MOMOTEST&redirectUrl=${body.redirectUrl}&requestId=${orderRef}&requestType=captureWallet`;
    expect(body.signature).toBe(createHmac('sha256', MOMO_SECRET).update(raw, 'utf-8').digest('hex'));
  });

  it('settles from a signed IPN with a bare 204; a forged IPN gets 400', async () => {
    const p: Record<string, unknown> = {
      partnerCode: 'MOMOTEST', orderId: orderRef, requestId: orderRef, amount: 499000,
      orderInfo: 'webmaket order payment', orderType: 'momo_wallet', transId: 3123000999,
      resultCode: 0, message: 'Successful.', payType: 'qr', responseTime: 1761844900000, extraData: '',
    };
    const raw = `accessKey=AKTEST123&amount=${p.amount}&extraData=&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=MOMOTEST&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
    const signature = createHmac('sha256', MOMO_SECRET).update(raw, 'utf-8').digest('hex');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/momo', payload: { ...p, signature } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');
    const forged = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/momo', payload: { ...p, signature: 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(400);
  });

  it('is the default after VNPay is disabled, and mock returns once both are off', async () => {
    await post('/api/v1/admin/settings/payment-vnpay', { enabled: false, tmn_code: 'TESTSHOP', sandbox: true }, ownerCookie);
    const o1 = await newOrder();
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ resultCode: 0, payUrl: 'https://test-payment.momo.vn/pay/xyz' }) }));
    try {
      const s1 = await post(`/api/v1/orders/${o1}/payment-sessions`, {}, buyerCookie);
      expect(s1.json().data.provider).toBe('momo');
    } finally {
      vi.unstubAllGlobals();
    }
    await post('/api/v1/admin/settings/payment-momo', { enabled: false, partner_code: 'MOMOTEST', access_key: 'AKTEST123', sandbox: true }, ownerCookie);
    const o2 = await newOrder();
    const s2 = await post(`/api/v1/orders/${o2}/payment-sessions`, {}, buyerCookie);
    expect(s2.json().data.provider).toBe('mock');
    const named = await post(`/api/v1/orders/${o2}/payment-sessions`, { provider: 'vnpay' }, buyerCookie);
    expect(named.statusCode).toBe(409);
  });
});

/** Independent re-implementation of payOS's documented webhook signer. */
function payosWebhookSign(data: Record<string, unknown>): string {
  const sortShallow = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = o[k];
    return out;
  };
  const qs = Object.keys(data)
    .sort()
    .filter((k) => data[k] !== undefined)
    .map((k) => {
      const v = data[k];
      if (v === null || v === undefined) return `${k}=`;
      if (Array.isArray(v)) return `${k}=${JSON.stringify(v.map((el) => (el !== null && typeof el === 'object' && !Array.isArray(el) ? sortShallow(el as Record<string, unknown>) : el)))}`;
      if (typeof v === 'object') return `${k}=${JSON.stringify(sortShallow(v as Record<string, unknown>))}`;
      return `${k}=${String(v)}`;
    })
    .join('&');
  return createHmac('sha256', PAYOS_CHECKSUM).update(qs, 'utf-8').digest('hex');
}

function payosWebhookBody(paymentLinkId: string, amount: number): Record<string, unknown> {
  const data: Record<string, unknown> = {
    orderCode: 123456789012,
    amount,
    description: 'WEBMAKET 123456789012',
    accountNumber: '42381717',
    reference: 'FT233200001',
    transactionDateTime: '2026-11-03T17:30:00',
    currency: 'VND',
    paymentLinkId,
    code: '00',
    desc: 'success',
    counterAccountBankId: null,
    counterAccountName: 'NGUYEN VAN A',
  };
  return { code: '00', desc: 'success', success: true, data, signature: payosWebhookSign(data) };
}

describe('payOS', () => {
  let orderId: string;

  it('stores merchant settings without ever returning the secrets; step-up is required', async () => {
    expect((await get('/api/v1/admin/settings/payment-payos', buyerCookie)).statusCode).toBe(403);
    const freshOwner = await createUser(ctx, 'gw-owner2@example.com', 'platform_owner');
    const noStepUp = await post('/api/v1/admin/settings/payment-payos', { enabled: true, client_id: PAYOS_CLIENT_ID, api_key: PAYOS_API_KEY, checksum_key: PAYOS_CHECKSUM }, freshOwner.cookie);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.body).toContain('auth.step_up_required');

    const res = await post('/api/v1/admin/settings/payment-payos', { enabled: true, client_id: PAYOS_CLIENT_ID, api_key: PAYOS_API_KEY, checksum_key: PAYOS_CHECKSUM }, ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: true, client_id: PAYOS_CLIENT_ID, api_key_configured: true, checksum_key_configured: true });
    expect(res.json().data.webhook_url).toContain('/api/v1/payments/webhooks/payos');
    expect(res.body).not.toContain(PAYOS_API_KEY);
    expect(res.body).not.toContain(PAYOS_CHECKSUM);
    const got = await get('/api/v1/admin/settings/payment-payos', ownerCookie);
    expect(got.json().data).toMatchObject({ enabled: true, client_id: PAYOS_CLIENT_ID, api_key_configured: true, checksum_key_configured: true });
    expect(got.body).not.toContain(PAYOS_API_KEY);
    expect(got.body).not.toContain(PAYOS_CHECKSUM);
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/v1/config/public' });
    expect(pub.json().data.payment.payos).toBe(true);
  });

  it('keeps stored secrets on an empty re-save and creates a signed payment link', async () => {
    const resave = await post('/api/v1/admin/settings/payment-payos', { enabled: true, client_id: PAYOS_CLIENT_ID, api_key: '', checksum_key: '' }, ownerCookie);
    expect(resave.statusCode, resave.body).toBe(200);
    expect(resave.json().data).toMatchObject({ api_key_configured: true, checksum_key_configured: true });

    orderId = await newOrder();
    let captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
    vi.stubGlobal('fetch', async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      captured = { url, headers: init.headers, body: init.body };
      return {
        json: async () => ({
          code: '00', desc: 'success',
          data: { bin: '970416', accountNumber: '42381717', accountName: 'PHAM TRUNG HIEU', amount: 499000, description: 'WEBMAKET', orderCode: 1, currency: 'VND', paymentLinkId: PAYOS_LINK_ID, status: 'PENDING', checkoutUrl: 'https://pay.payos.vn/web/payoslinktest123', qrCode: '00020101021238520010A000000727' },
        }),
      };
    });
    let res;
    try {
      res = await post(`/api/v1/orders/${orderId}/payment-sessions`, { provider: 'payos' }, buyerCookie);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(res.statusCode, res.body).toBe(201);
    const session = res.json().data;
    expect(session.provider).toBe('payos');
    expect(session.provider_ref).toBe(PAYOS_LINK_ID);
    expect(session.pay_url).toBe('https://pay.payos.vn/web/payoslinktest123');
    expect(session.instructions).toMatchObject({
      qr_payload: '00020101021238520010A000000727',
      account_number: '42381717',
      account_name: 'PHAM TRUNG HIEU',
      bank_bin: '970416',
      amount_minor: '499000',
      checkout_url: 'https://pay.payos.vn/web/payoslinktest123',
    });
    // The create call went out with the merchant headers and a signature
    // over the documented five-field string — against the secrets kept
    // from the first save, proving the seal/keep/open round trip.
    expect(captured.url).toBe('https://api-merchant.payos.vn/v2/payment-requests');
    expect(captured.headers).toMatchObject({ 'x-client-id': PAYOS_CLIENT_ID, 'x-api-key': PAYOS_API_KEY });
    const sent = JSON.parse(captured.body!) as { orderCode: number; amount: number; description: string; returnUrl: string; cancelUrl: string; expiredAt?: number; signature: string };
    expect(sent.description).toBe(`WEBMAKET ${sent.orderCode}`);
    expect(sent.amount).toBe(499000);
    expect(sent.returnUrl).toBe(sent.cancelUrl);
    expect(sent.returnUrl).toContain(`/checkout/orders/${orderId}/pay`);
    expect(typeof sent.expiredAt).toBe('number');
    const expectedSig = createHmac('sha256', PAYOS_CHECKSUM)
      .update(`amount=${sent.amount}&cancelUrl=${sent.cancelUrl}&description=${sent.description}&orderCode=${sent.orderCode}&returnUrl=${sent.returnUrl}`, 'utf-8')
      .digest('hex');
    expect(sent.signature).toBe(expectedSig);
  });

  it('settles from a signed webhook; forged signatures get 400 and unknown links are ignored with 200', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/payos', payload: payosWebhookBody(PAYOS_LINK_ID, 499000) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ success: true, outcome: 'processed' });
    expect((await get(`/api/v1/orders/${orderId}`, buyerCookie)).json().data.payment_status).toBe('paid');

    const forged = payosWebhookBody(PAYOS_LINK_ID, 499000);
    forged.signature = 'f'.repeat(64);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/payos', payload: forged });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('payment.webhook_invalid');

    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/v1/payments/webhooks/payos', payload: payosWebhookBody('payos-link-nobody-knows', 1000) });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ success: true, outcome: 'ignored' });
  });
});
