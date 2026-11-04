import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MoMoProvider, PayosProvider, VnPayProvider, parseMoMoCreateResponse, parsePayosCreateResponse } from './payment-gateways.ts';

/** Independent re-implementations of the vendors' documented signing
 *  schemes, so the providers are checked against the spec, not themselves. */
function vnpaySign(params: Record<string, string>, secret: string): string {
  const data = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&');
  return createHmac('sha512', secret).update(data, 'utf-8').digest('hex');
}
function momoSign(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw, 'utf-8').digest('hex');
}

const VNP_SECRET = 'VNPAYTESTSECRET0123456789ABCDEF';
const vnp = new VnPayProvider({ tmnCode: 'TESTSHOP', secret: VNP_SECRET, sandbox: true });

function vnpayIpn(overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    vnp_Amount: '49900000',
    vnp_BankCode: 'NCB',
    vnp_OrderInfo: 'webmaket order payment',
    vnp_PayDate: '20261030220000',
    vnp_ResponseCode: '00',
    vnp_TmnCode: 'TESTSHOP',
    vnp_TransactionNo: '14123456',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: 'VPABCDEF123456',
    ...overrides,
  };
  const query = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&');
  return `${query}&vnp_SecureHash=${vnpaySign(params, VNP_SECRET)}`;
}

describe('VnPayProvider', () => {
  it('builds a signed sandbox redirect URL with the amount in dong x 100', () => {
    const s = vnp.createSession({ orderId: 'o1', amountMinor: '499000', currency: 'VND', returnUrl: 'https://webmaket.com/result', expiresAt: new Date(Date.now() + 900_000), ipAddr: '1.2.3.4' });
    expect(s.providerRef).toMatch(/^VP[0-9A-F]{12}$/);
    const url = new URL(s.payUrl);
    expect(url.origin + url.pathname).toBe('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
    expect(url.searchParams.get('vnp_Amount')).toBe('49900000');
    expect(url.searchParams.get('vnp_TxnRef')).toBe(s.providerRef);
    expect(url.searchParams.get('vnp_SecureHash')).toMatch(/^[0-9a-f]{128}$/);
  });

  it('verifies a settled IPN and maps the amount back to dong', () => {
    const event = vnp.verifyWebhook(vnpayIpn());
    expect(event).toMatchObject({ providerEventId: 'vnp_14123456', providerRef: 'VPABCDEF123456', status: 'settled', amountMinor: '499000', currency: 'VND' });
  });

  it('maps a cancelled payment to failed, never settled', () => {
    const event = vnp.verifyWebhook(vnpayIpn({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02' }));
    expect(event.status).toBe('failed');
  });

  it('rejects a tampered amount and a foreign merchant code', () => {
    const good = vnpayIpn();
    const tampered = good.replace('vnp_Amount=49900000', 'vnp_Amount=100');
    expect(() => vnp.verifyWebhook(tampered)).toThrow();
    expect(() => vnp.verifyWebhook(vnpayIpn({ vnp_TmnCode: 'OTHER' }))).toThrow();
  });
});

const MOMO_SECRET = 'MOMOTESTSECRETKEY0123456789';
const momo = new MoMoProvider({ partnerCode: 'MOMOTEST', accessKey: 'AKTEST123', secretKey: MOMO_SECRET, sandbox: true });

function momoIpn(overrides: Record<string, unknown> = {}): string {
  const p: Record<string, unknown> = {
    partnerCode: 'MOMOTEST',
    orderId: 'MMABCDEF123456',
    requestId: 'MMABCDEF123456',
    amount: 499000,
    orderInfo: 'webmaket order payment',
    orderType: 'momo_wallet',
    transId: 3123456789,
    resultCode: 0,
    message: 'Successful.',
    payType: 'qr',
    responseTime: 1761844800000,
    extraData: '',
    ...overrides,
  };
  const raw = `accessKey=AKTEST123&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
  return JSON.stringify({ ...p, signature: momoSign(raw, MOMO_SECRET) });
}

describe('MoMoProvider', () => {
  it('signs the create body per the documented raw-string scheme', () => {
    const body = momo.buildCreateBody({ orderRef: 'MMABCDEF123456', amountMinor: '499000', redirectUrl: 'https://webmaket.com/result', ipnUrl: 'https://webmaket.com/ipn' });
    const raw = 'accessKey=AKTEST123&amount=499000&extraData=&ipnUrl=https://webmaket.com/ipn&orderId=MMABCDEF123456&orderInfo=webmaket order payment&partnerCode=MOMOTEST&redirectUrl=https://webmaket.com/result&requestId=MMABCDEF123456&requestType=captureWallet';
    expect(body.signature).toBe(momoSign(raw, MOMO_SECRET));
    expect(body.amount).toBe(499000);
    expect(momo.createEndpoint).toBe('https://test-payment.momo.vn/v2/gateway/api/create');
  });

  it('verifies a settled IPN; a failed resultCode never settles', () => {
    expect(momo.verifyIpn(momoIpn())).toMatchObject({ providerEventId: 'momo_3123456789', providerRef: 'MMABCDEF123456', status: 'settled', amountMinor: '499000' });
    expect(momo.verifyIpn(momoIpn({ resultCode: 1006, message: 'Transaction cancelled by user.' })).status).toBe('failed');
  });

  it('rejects an IPN signed with the wrong secret', () => {
    const body = JSON.parse(momoIpn()) as Record<string, unknown>;
    body.signature = momoSign('accessKey=AKTEST123&amount=1', 'WRONGSECRET');
    expect(() => momo.verifyIpn(JSON.stringify(body))).toThrow();
  });
});

const PAYOS_CHECKSUM = 'PAYOSCHECKSUMKEY0123456789ABCDEF0123';
const payos = new PayosProvider({ clientId: 'payos-client-id', apiKey: 'payos-api-key', checksumKey: PAYOS_CHECKSUM });

/** Independent re-implementation of payOS's documented webhook signer. */
function payosWebhookSign(data: Record<string, unknown>, checksum: string): string {
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
  return createHmac('sha256', checksum).update(qs, 'utf-8').digest('hex');
}

function payosWebhook(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  const data: Record<string, unknown> = {
    orderCode: 987654321,
    amount: 499000,
    description: 'WEBMAKET 987654321',
    accountNumber: '42381717',
    reference: 'FT233200001',
    transactionDateTime: '2026-11-03T17:30:00',
    currency: 'VND',
    paymentLinkId: 'payoslink123abc',
    code: '00',
    desc: 'success',
    counterAccountBankId: null,
    counterAccountName: 'NGUYEN VAN A',
    ...dataOverrides,
  };
  const body: Record<string, unknown> = { code: '00', desc: 'success', success: true, data, ...overrides };
  return JSON.stringify({ ...body, signature: payosWebhookSign(data, PAYOS_CHECKSUM) });
}

describe('PayosProvider', () => {
  it('signs the create request per the documented five-field string', () => {
    const input = { amount: 499000, cancelUrl: 'https://webmaket.com/checkout/orders/o1/pay', description: 'WEBMAKET 987654321', orderCode: 987654321, returnUrl: 'https://webmaket.com/checkout/orders/o1/pay' };
    const expected = createHmac('sha256', PAYOS_CHECKSUM)
      .update('amount=499000&cancelUrl=https://webmaket.com/checkout/orders/o1/pay&description=WEBMAKET 987654321&orderCode=987654321&returnUrl=https://webmaket.com/checkout/orders/o1/pay', 'utf-8')
      .digest('hex');
    expect(payos.buildCreateSignature(input)).toBe(expected);
    expect(payos.createEndpoint).toBe('https://api-merchant.payos.vn/v2/payment-requests');
  });

  it('creates a payment link with client headers and the signed body', async () => {
    let seenUrl = '';
    let seenInit: { headers?: Record<string, string>; body?: string } = {};
    const fetchFn = (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
      seenUrl = url;
      seenInit = init;
      return {
        json: async () => ({
          code: '00', desc: 'success',
          data: { bin: '970416', accountNumber: '42381717', accountName: 'PHAM TRUNG HIEU', amount: 499000, description: 'WEBMAKET 987654321', orderCode: 987654321, currency: 'VND', paymentLinkId: 'payoslink123abc', status: 'PENDING', checkoutUrl: 'https://pay.payos.vn/web/payoslink123abc', qrCode: '00020101021238...' },
        }),
      };
    }) as unknown as typeof fetch;
    const created = await payos.createPaymentLink(
      { orderCode: 987654321, amountMinor: '499000', description: 'WEBMAKET 987654321', returnUrl: 'https://webmaket.com/pay', cancelUrl: 'https://webmaket.com/pay', expiredAt: 1794000000 },
      fetchFn,
    );
    expect(seenUrl).toBe('https://api-merchant.payos.vn/v2/payment-requests');
    expect(seenInit.headers).toMatchObject({ 'x-client-id': 'payos-client-id', 'x-api-key': 'payos-api-key' });
    const sent = JSON.parse(seenInit.body!) as Record<string, unknown>;
    expect(sent).toMatchObject({ orderCode: 987654321, amount: 499000, expiredAt: 1794000000 });
    expect(sent.signature).toBe(payos.buildCreateSignature({ amount: 499000, cancelUrl: 'https://webmaket.com/pay', description: 'WEBMAKET 987654321', orderCode: 987654321, returnUrl: 'https://webmaket.com/pay' }));
    expect(created).toEqual({
      checkoutUrl: 'https://pay.payos.vn/web/payoslink123abc',
      qrCode: '00020101021238...',
      paymentLinkId: 'payoslink123abc',
      bin: '970416',
      accountNumber: '42381717',
      accountName: 'PHAM TRUNG HIEU',
    });
  });

  it('surfaces the gateway desc when create fails', async () => {
    const fetchFn = (async () => ({ json: async () => ({ code: '20', desc: 'Invalid signature', data: null }) })) as unknown as typeof fetch;
    await expect(
      payos.createPaymentLink({ orderCode: 1, amountMinor: '1000', description: 'WEBMAKET 1', returnUrl: 'https://x', cancelUrl: 'https://x' }, fetchFn),
    ).rejects.toThrow('Invalid signature');
  });

  it('verifies a settled webhook — null fields sign as empty strings', () => {
    const event = payos.verifyWebhook(payosWebhook());
    expect(event).toMatchObject({
      providerEventId: 'payos_payoslink123abc_FT233200001',
      providerRef: 'payoslink123abc',
      status: 'settled',
      amountMinor: '499000',
      currency: 'VND',
    });
  });

  it('maps a non-success webhook to failed, never settled', () => {
    expect(payos.verifyWebhook(payosWebhook({ success: false, code: '01', desc: 'failed' }, { code: '01', desc: 'Cancelled' })).status).toBe('failed');
  });

  it('rejects a tampered amount and a foreign checksum', () => {
    const good = payosWebhook();
    const tampered = good.replace('"amount":499000', '"amount":100');
    expect(() => payos.verifyWebhook(tampered)).toThrow();
    const body = JSON.parse(good) as Record<string, unknown>;
    body.signature = payosWebhookSign(body.data as Record<string, unknown>, 'WRONGCHECKSUM');
    expect(() => payos.verifyWebhook(JSON.stringify(body))).toThrow();
  });
});

describe('parsePayosCreateResponse', () => {
  it('extracts the checkout URL and QR payload', () => {
    expect(parsePayosCreateResponse({ code: '00', data: { checkoutUrl: 'https://pay.payos.vn/web/x', paymentLinkId: 'x', qrCode: '000201...', bin: '970416', accountNumber: '123', accountName: 'A' } }))
      .toEqual({ checkoutUrl: 'https://pay.payos.vn/web/x', qrCode: '000201...', paymentLinkId: 'x', bin: '970416', accountNumber: '123', accountName: 'A' });
  });
  it('rejects failures and incomplete data', () => {
    expect(parsePayosCreateResponse({ code: '20', data: { checkoutUrl: 'https://pay.payos.vn/web/x', paymentLinkId: 'x' } })).toBeNull();
    expect(parsePayosCreateResponse({ code: '00', data: {} })).toBeNull();
  });
});

describe('parseMoMoCreateResponse', () => {
  it('extracts the pay URL and the native QR payload', () => {
    expect(parseMoMoCreateResponse({ resultCode: 0, payUrl: 'https://payment.momo.vn/pay/abc', qrCodeUrl: '00020101021226...' }))
      .toEqual({ payUrl: 'https://payment.momo.vn/pay/abc', qrPayload: '00020101021226...' });
  });
  it('tolerates a missing QR payload and rejects failures', () => {
    expect(parseMoMoCreateResponse({ resultCode: 0, payUrl: 'https://payment.momo.vn/pay/abc' }))
      .toEqual({ payUrl: 'https://payment.momo.vn/pay/abc', qrPayload: null });
    expect(parseMoMoCreateResponse({ resultCode: 1006, payUrl: 'https://payment.momo.vn/pay/abc' })).toBeNull();
    expect(parseMoMoCreateResponse({ resultCode: 0 })).toBeNull();
  });
});
