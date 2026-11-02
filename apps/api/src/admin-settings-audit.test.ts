import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, stepUp, ORIGIN, type TestContext } from './test-helpers.ts';

/** Admin settings audit (owner directive 2026-11-01): every settings
 *  surface must (a) return sane defaults on a fresh install, (b) save
 *  via POST and read back the same values via GET, (c) reject invalid
 *  input with 422, and (d) propagate to the public /config/public view
 *  where buyers see it. Secrets (bank hub key, gateway keys) are
 *  write-only and must never appear in any response body. */
let ctx: TestContext;
let ownerCookie: string;
let buyerCookie: string;

const get = (url: string, cookie?: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const post = (url: string, payload: unknown, cookie?: string) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

const ADMIN_GETS = [
  '/api/v1/admin/settings/contact',
  '/api/v1/admin/settings/subdomain-fee',
  '/api/v1/admin/settings/subdomain-reservation',
  '/api/v1/admin/settings/installation-service',
  '/api/v1/admin/settings/hosting-storage',
  '/api/v1/admin/settings/payment',
  '/api/v1/admin/settings/payment-vnpay',
  '/api/v1/admin/settings/payment-momo',
  '/api/v1/admin/settings/payment-paypal',
  '/api/v1/admin/settings/payment-usd',
  '/api/v1/admin/settings/ads',
];

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createUser(ctx, 'audit-owner@example.com', 'platform_owner');
  ownerCookie = owner.cookie;
  await stepUp(ctx, ownerCookie); // wave-1: payment settings + manual confirm require step-up
  const buyer = await createUser(ctx, 'audit-buyer@example.com');
  buyerCookie = buyer.cookie;
}, 120_000);
afterAll(async () => ctx.close());

describe('authorization: settings are staff-only', () => {
  it('rejects a plain buyer with 403 on every settings GET', async () => {
    for (const url of ADMIN_GETS) {
      const res = await get(url, buyerCookie);
      expect(res.statusCode, `${url} -> ${res.body}`).toBe(403);
    }
  });

  it('rejects an anonymous caller with 401 and a buyer POST with 403', async () => {
    const anon = await get('/api/v1/admin/settings/contact');
    expect(anon.statusCode, anon.body).toBe(401);
    const buyerPost = await post('/api/v1/admin/settings/contact', { phone: '0900000000' }, buyerCookie);
    expect(buyerPost.statusCode, buyerPost.body).toBe(403);
  });
});

describe('1. contact channels', () => {
  it('returns empty defaults', async () => {
    const res = await get('/api/v1/admin/settings/contact', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ phone: '', zalo: '', messenger: '', email: '' });
  });

  it('rejects an invalid email and an invalid phone with 422', async () => {
    const badEmail = await post('/api/v1/admin/settings/contact', { email: 'khong-phai-email' }, ownerCookie);
    expect(badEmail.statusCode, badEmail.body).toBe(422);
    expect(badEmail.json().error.code).toBe('validation.failed');
    const badPhone = await post('/api/v1/admin/settings/contact', { phone: 'goi cho toi!' }, ownerCookie);
    expect(badPhone.statusCode, badPhone.body).toBe(422);
  });

  it('saves, reads back, and propagates to /config/public', async () => {
    const value = {
      phone: '+84 967 136 099',
      zalo: 'https://zalo.me/0967136099',
      messenger: 'https://m.me/webmaket',
      email: 'hotro@webmaket.com',
    };
    const saved = await post('/api/v1/admin/settings/contact', value, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual(value);
    const back = await get('/api/v1/admin/settings/contact', ownerCookie);
    expect(back.json().data).toEqual(value);
    const pub = await get('/api/v1/config/public');
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().data.contact).toEqual(value);
  });
});

describe('2. subdomain fee', () => {
  it('returns unset defaults and no public fee', async () => {
    const res = await get('/api/v1/admin/settings/subdomain-fee', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ amount_minor: null, period: 'once' });
    // Migration 0016 seeds the fee row with a null amount ("not published
    // yet"), so the public view exposes the shape with amount_minor null
    // rather than a null fee object.
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.subdomain_fee).toEqual({ amount_minor: null, period: 'once' });
  });

  it('rejects non-positive amounts with 422', async () => {
    const neg = await post('/api/v1/admin/settings/subdomain-fee', { amount_minor: -5000, period: 'monthly' }, ownerCookie);
    expect(neg.statusCode, neg.body).toBe(422);
    const zero = await post('/api/v1/admin/settings/subdomain-fee', { amount_minor: 0 }, ownerCookie);
    expect(zero.statusCode, zero.body).toBe(422);
  });

  it('saves the monthly fee, reads back, and propagates', async () => {
    const value = { amount_minor: 10000, period: 'monthly' };
    const saved = await post('/api/v1/admin/settings/subdomain-fee', value, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual(value);
    const back = await get('/api/v1/admin/settings/subdomain-fee', ownerCookie);
    expect(back.json().data).toEqual(value);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.subdomain_fee).toEqual(value);
  });
});

describe('3. subdomain reservation TTL', () => {
  it('defaults to 15 minutes', async () => {
    const res = await get('/api/v1/admin/settings/subdomain-reservation', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ ttl_minutes: 15 });
  });

  it('rejects out-of-range and non-integer TTLs with 422', async () => {
    for (const ttl of [0, 1441, -5, 15.5]) {
      const res = await post('/api/v1/admin/settings/subdomain-reservation', { ttl_minutes: ttl }, ownerCookie);
      expect(res.statusCode, `ttl=${ttl} -> ${res.body}`).toBe(422);
    }
  });

  it('accepts the bounds and an in-range value, reading each back', async () => {
    for (const ttl of [1, 1440, 45]) {
      const saved = await post('/api/v1/admin/settings/subdomain-reservation', { ttl_minutes: ttl }, ownerCookie);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().data).toEqual({ ttl_minutes: ttl });
      const back = await get('/api/v1/admin/settings/subdomain-reservation', ownerCookie);
      expect(back.json().data).toEqual({ ttl_minutes: ttl });
    }
  });
});

describe('4. installation service package', () => {
  it('returns disabled/unpriced defaults and is unavailable publicly', async () => {
    const res = await get('/api/v1/admin/settings/installation-service', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ enabled: false, amount_minor: null });
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.installation_service).toEqual({ available: false, amount_minor: null });
  });

  it('refuses to enable without a price, and rejects a non-positive price', async () => {
    const noPrice = await post('/api/v1/admin/settings/installation-service', { enabled: true }, ownerCookie);
    expect(noPrice.statusCode, noPrice.body).toBe(422);
    const nullPrice = await post('/api/v1/admin/settings/installation-service', { enabled: true, amount_minor: null }, ownerCookie);
    expect(nullPrice.statusCode, nullPrice.body).toBe(422);
    const neg = await post('/api/v1/admin/settings/installation-service', { enabled: true, amount_minor: -1 }, ownerCookie);
    expect(neg.statusCode, neg.body).toBe(422);
  });

  it('saves enabled + price, reads back, and becomes available publicly', async () => {
    const saved = await post('/api/v1/admin/settings/installation-service', { enabled: true, amount_minor: 300000 }, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual({ enabled: true, amount_minor: 300000 });
    const back = await get('/api/v1/admin/settings/installation-service', ownerCookie);
    expect(back.json().data).toEqual({ enabled: true, amount_minor: 300000 });
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.installation_service).toEqual({ available: true, amount_minor: 300000 });
  });
});

describe('5. hosting storage price (per GB)', () => {
  it('returns unset defaults', async () => {
    const res = await get('/api/v1/admin/settings/hosting-storage', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ per_gb_minor: null });
  });

  it('rejects zero and negative rates with 422', async () => {
    const zero = await post('/api/v1/admin/settings/hosting-storage', { per_gb_minor: 0 }, ownerCookie);
    expect(zero.statusCode, zero.body).toBe(422);
    const neg = await post('/api/v1/admin/settings/hosting-storage', { per_gb_minor: -100 }, ownerCookie);
    expect(neg.statusCode, neg.body).toBe(422);
  });

  it('saves the single per-GB rate, reads back, and propagates', async () => {
    const value = { per_gb_minor: 50000 };
    const saved = await post('/api/v1/admin/settings/hosting-storage', value, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual(value);
    const back = await get('/api/v1/admin/settings/hosting-storage', ownerCookie);
    expect(back.json().data).toEqual(value);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.hosting_storage).toEqual(value);
  });
});

describe('6. bank transfer payment settings', () => {
  const HUB_SECRET = 'AUDIT-HUB-SECRET-1';

  it('returns disabled defaults with no hub configured', async () => {
    const res = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json().data;
    expect(d.enabled).toBe(false);
    expect(d.bank_name).toBe('');
    expect(d.account_number).toBe('');
    expect(d.account_holder).toBe('');
    expect(d.hub_configured).toBe(false);
    expect(d.webhook_url).toContain('/api/v1/payments/webhooks/bank_transfer');
    expect(res.body).not.toContain('hub_api_key');
  });

  it('refuses to enable without the required bank fields', async () => {
    const bare = await post('/api/v1/admin/settings/payment', { enabled: true }, ownerCookie);
    expect(bare.statusCode, bare.body).toBe(422);
    const noHolder = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', account_number: '0123456789',
    }, ownerCookie);
    expect(noHolder.statusCode, noHolder.body).toBe(422);
    const badAccount = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', account_number: 'abc', account_holder: 'WEBMAKET',
    }, ownerCookie);
    expect(badAccount.statusCode, badAccount.body).toBe(422);
  });

  it('rejects a malformed bank BIN with 422', async () => {
    const res = await post('/api/v1/admin/settings/payment', { enabled: false, bank_bin: '97043' }, ownerCookie);
    expect(res.statusCode, res.body).toBe(422);
  });

  it('saves with a hub key that is write-only and never returned', async () => {
    const saved = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
      account_number: '0123 456 789', account_holder: 'WEBMAKET TEST', hub_api_key: HUB_SECRET,
    }, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(HUB_SECRET);
    const d = saved.json().data;
    expect(d.hub_configured).toBe(true);
    // Account number whitespace is stripped on save.
    expect(d.account_number).toBe('0123456789');
    expect(d.bank_bin).toBe('970436');

    const back = await get('/api/v1/admin/settings/payment', ownerCookie);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.body).not.toContain(HUB_SECRET);
    expect(back.json().data.hub_configured).toBe(true);
    expect(back.json().data.enabled).toBe(true);

    // A later POST without the key keeps the stored one.
    const kept = await post('/api/v1/admin/settings/payment', {
      enabled: true, bank_name: 'Vietcombank', bank_bin: '970436',
      account_number: '0123456789', account_holder: 'WEBMAKET TEST',
    }, ownerCookie);
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().data.hub_configured).toBe(true);

    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.payment.bank_transfer).toBe(true);
  });
});

describe('7a. VNPay gateway settings', () => {
  const SECRET = 'VNPAY-AUDIT-SECRET';

  it('returns disabled defaults, sandbox on, no secret', async () => {
    const res = await get('/api/v1/admin/settings/payment-vnpay', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: false, tmn_code: '', secret_configured: false, sandbox: true });
    expect(res.body).not.toContain('secret_key');
  });

  it('refuses to enable without TMN code and secret', async () => {
    const noSecret = await post('/api/v1/admin/settings/payment-vnpay', { enabled: true, tmn_code: 'TMN12345' }, ownerCookie);
    expect(noSecret.statusCode, noSecret.body).toBe(422);
    const noTmn = await post('/api/v1/admin/settings/payment-vnpay', { enabled: true, secret_key: SECRET }, ownerCookie);
    expect(noTmn.statusCode, noTmn.body).toBe(422);
  });

  it('saves with a write-only secret and propagates as enabled', async () => {
    const saved = await post('/api/v1/admin/settings/payment-vnpay', {
      enabled: true, tmn_code: 'TMN12345', secret_key: SECRET, sandbox: true,
    }, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(SECRET);
    expect(saved.json().data).toMatchObject({ enabled: true, tmn_code: 'TMN12345', secret_configured: true, sandbox: true });
    const back = await get('/api/v1/admin/settings/payment-vnpay', ownerCookie);
    expect(back.body).not.toContain(SECRET);
    expect(back.json().data.secret_configured).toBe(true);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.payment.vnpay).toBe(true);
  });
});

describe('7b. MoMo gateway settings', () => {
  const SECRET = 'MOMO-AUDIT-SECRET';

  it('returns disabled defaults, sandbox on, no secret', async () => {
    const res = await get('/api/v1/admin/settings/payment-momo', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: false, partner_code: '', access_key: '', secret_configured: false, sandbox: true });
    expect(res.body).not.toContain('secret_key');
  });

  it('refuses to enable without partner code, access key and secret', async () => {
    const partial = await post('/api/v1/admin/settings/payment-momo', { enabled: true, partner_code: 'MOMO123' }, ownerCookie);
    expect(partial.statusCode, partial.body).toBe(422);
    const noSecret = await post('/api/v1/admin/settings/payment-momo', {
      enabled: true, partner_code: 'MOMO123', access_key: 'AK-AUDIT',
    }, ownerCookie);
    expect(noSecret.statusCode, noSecret.body).toBe(422);
  });

  it('saves with a write-only secret and propagates as enabled', async () => {
    const saved = await post('/api/v1/admin/settings/payment-momo', {
      enabled: true, partner_code: 'MOMO123', access_key: 'AK-AUDIT', secret_key: SECRET, sandbox: false,
    }, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(SECRET);
    expect(saved.json().data).toMatchObject({ enabled: true, partner_code: 'MOMO123', access_key: 'AK-AUDIT', secret_configured: true, sandbox: false });
    const back = await get('/api/v1/admin/settings/payment-momo', ownerCookie);
    expect(back.body).not.toContain(SECRET);
    expect(back.json().data.secret_configured).toBe(true);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.payment.momo).toBe(true);
  });
});

describe('8. PayPal manual payment settings', () => {
  it('returns disabled defaults', async () => {
    const res = await get('/api/v1/admin/settings/payment-paypal', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ enabled: false, email: '', holder: '' });
  });

  it('rejects enabling with an invalid email', async () => {
    const res = await post('/api/v1/admin/settings/payment-paypal', { enabled: true, email: 'khong-phai-email', holder: 'WEBMAKET' }, ownerCookie);
    expect(res.statusCode, res.body).toBe(422);
  });

  it('saves, reads back, and propagates as enabled', async () => {
    const value = { enabled: true, email: 'nhan-tien@webmaket.com', holder: 'WEBMAKET' };
    const saved = await post('/api/v1/admin/settings/payment-paypal', value, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual(value);
    const back = await get('/api/v1/admin/settings/payment-paypal', ownerCookie);
    expect(back.json().data).toEqual(value);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.payment.paypal).toBe(true);
  });
});

describe('9. USD transfer payment settings', () => {
  it('returns disabled defaults with a zero rate', async () => {
    const res = await get('/api/v1/admin/settings/payment-usd', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({
      enabled: false, bank_name: '', account_number: '', account_holder: '', swift_code: '', usd_rate: 0,
    });
  });

  it('refuses to enable without bank fields and a positive rate', async () => {
    const bare = await post('/api/v1/admin/settings/payment-usd', { enabled: true, bank_name: 'HSBC' }, ownerCookie);
    expect(bare.statusCode, bare.body).toBe(422);
    const noRate = await post('/api/v1/admin/settings/payment-usd', {
      enabled: true, bank_name: 'HSBC', account_number: '123456789', account_holder: 'WEBMAKET', usd_rate: 0,
    }, ownerCookie);
    expect(noRate.statusCode, noRate.body).toBe(422);
  });

  it('rejects a malformed SWIFT code when enabling', async () => {
    const res = await post('/api/v1/admin/settings/payment-usd', {
      enabled: true, bank_name: 'HSBC', account_number: '123456789', account_holder: 'WEBMAKET',
      swift_code: 'bad!', usd_rate: 25500,
    }, ownerCookie);
    expect(res.statusCode, res.body).toBe(422);
  });

  it('saves normalized values, reads back, and propagates as enabled', async () => {
    const saved = await post('/api/v1/admin/settings/payment-usd', {
      enabled: true, bank_name: 'HSBC USA', account_number: '123 456 789', account_holder: 'WEBMAKET LLC',
      swift_code: 'hsbcus33', usd_rate: 25500,
    }, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    const expected = {
      enabled: true, bank_name: 'HSBC USA', account_number: '123456789',
      account_holder: 'WEBMAKET LLC', swift_code: 'HSBCUS33', usd_rate: 25500,
    };
    expect(saved.json().data).toEqual(expected);
    const back = await get('/api/v1/admin/settings/payment-usd', ownerCookie);
    expect(back.json().data).toEqual(expected);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.payment.usd_transfer).toBe(true);
  });
});

describe('10. side-rail ads settings', () => {
  it('returns disabled defaults with empty sides, invisible publicly', async () => {
    const res = await get('/api/v1/admin/settings/ads', ownerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({
      enabled: false,
      left: { image_url: '', link_url: '', alt: '' },
      right: { image_url: '', link_url: '', alt: '' },
    });
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.ads).toEqual({ left: null, right: null });
  });

  it('rejects a non-http(s) image URL and a link without an image', async () => {
    const js = await post('/api/v1/admin/settings/ads', { enabled: true, left: { image_url: 'javascript:alert(1)' } }, ownerCookie);
    expect(js.statusCode, js.body).toBe(422);
    const protoRelative = await post('/api/v1/admin/settings/ads', { enabled: true, left: { image_url: '//evil.example.com/x.png' } }, ownerCookie);
    expect(protoRelative.statusCode, protoRelative.body).toBe(422);
    const linkOnly = await post('/api/v1/admin/settings/ads', { enabled: true, left: { link_url: 'https://example.com/x' } }, ownerCookie);
    expect(linkOnly.statusCode, linkOnly.body).toBe(422);
  });

  it('saves, reads back, and exposes only configured sides publicly', async () => {
    const value = {
      enabled: true,
      left: { image_url: 'https://cdn.example.com/ad-left.png', link_url: 'https://example.com/khuyen-mai', alt: 'Quảng cáo trái' },
      right: { image_url: '/ads/right.png', link_url: '', alt: '' },
    };
    const saved = await post('/api/v1/admin/settings/ads', value, ownerCookie);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toEqual(value);
    const back = await get('/api/v1/admin/settings/ads', ownerCookie);
    expect(back.json().data).toEqual(value);
    const pub = await get('/api/v1/config/public');
    expect(pub.json().data.ads.left).toEqual({
      image_url: 'https://cdn.example.com/ad-left.png', link_url: 'https://example.com/khuyen-mai', alt: 'Quảng cáo trái',
    });
    expect(pub.json().data.ads.right).toEqual({ image_url: '/ads/right.png', link_url: null, alt: '' });
  });
});
