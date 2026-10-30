import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MoMoProvider, VnPayProvider } from './payment-gateways.ts';

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
