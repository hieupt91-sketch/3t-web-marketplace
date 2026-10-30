import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NormalizedEvent, PaymentProvider, PaymentSession } from './payment.ts';
import { WebhookVerificationError } from './payment.ts';

/**
 * Real payment gateways (owner request 2026-10-30: fully automatic, settles
 * at 3am without staff). Both providers follow the same contract as the
 * mock: the platform never trusts the buyer's browser return — settlement
 * comes only from the gateway's signed server-to-server IPN, verified here
 * and applied by the shared settlement pipeline (amount checked against
 * the order, dedupe by gateway transaction id).
 *
 * Merchant credentials live in admin settings (never in code or env), so
 * the owner pastes the keys VNPay/MoMo issue and the method turns on.
 */

function hmacHex(algorithm: 'sha256' | 'sha512', secret: string, data: string): string {
  return createHmac(algorithm, secret).update(data, 'utf-8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** yyyyMMddHHmmss in Asia/Ho_Chi_Minh (VNPay's expected timezone). */
function vnTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

// ---------------------------------------------------------------- VNPay

export interface VnPayConfig {
  tmnCode: string;
  secret: string;
  sandbox: boolean;
}

const VNPAY_HOST = { sandbox: 'https://sandbox.vnpayment.vn', production: 'https://pay.vnpay.vn' } as const;

/**
 * VNPay (paymentv2). Session creation is a signed redirect URL — no server
 * call — so it fits the PaymentProvider shape directly. Amounts on the
 * wire are dong x 100; this platform's minor unit for VND is the dong, so
 * the conversion happens exactly here and nowhere else.
 */
export class VnPayProvider implements PaymentProvider {
  readonly name = 'vnpay';
  readonly sandbox: boolean;
  constructor(private readonly cfg: VnPayConfig) {
    this.sandbox = cfg.sandbox;
  }

  static newTxnRef(): string {
    return `VP${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  }

  private sign(params: Record<string, string>): string {
    const keys = Object.keys(params).sort();
    const data = keys.map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&');
    return hmacHex('sha512', this.cfg.secret, data);
  }

  createSession(input: { orderId: string; amountMinor: string; currency: string; returnUrl: string; expiresAt: Date; ipAddr?: string }): PaymentSession {
    const txnRef = VnPayProvider.newTxnRef();
    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.cfg.tmnCode,
      vnp_Amount: String(BigInt(input.amountMinor) * 100n),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: txnRef,
      vnp_OrderInfo: 'webmaket order payment',
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: input.ipAddr ?? '127.0.0.1',
      vnp_CreateDate: vnTimestamp(new Date()),
      vnp_ExpireDate: vnTimestamp(input.expiresAt),
    };
    const hash = this.sign(params);
    const query = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k]!)}`).join('&');
    const host = this.cfg.sandbox ? VNPAY_HOST.sandbox : VNPAY_HOST.production;
    return { providerRef: txnRef, payUrl: `${host}/paymentv2/vpcpay.html?${query}&vnp_SecureHash=${hash}`, expiresAt: input.expiresAt };
  }

  /** Verify an IPN query (rawBody carries the raw query string, no '?'). */
  verifyWebhook(rawBody: string): NormalizedEvent {
    const parsed = new URLSearchParams(rawBody);
    const provided = parsed.get('vnp_SecureHash');
    if (!provided) throw new WebhookVerificationError('missing_signature');
    const params: Record<string, string> = {};
    for (const [key, value] of parsed.entries()) {
      if (key === 'vnp_SecureHash' || key === 'vnp_SecureHashType') continue;
      params[key] = value;
    }
    if (params.vnp_TmnCode !== this.cfg.tmnCode) throw new WebhookVerificationError('wrong_merchant');
    if (!safeEqual(this.sign(params).toLowerCase(), provided.toLowerCase())) {
      throw new WebhookVerificationError('bad_signature');
    }
    const txnRef = params.vnp_TxnRef;
    const amountRaw = params.vnp_Amount;
    if (!txnRef || !amountRaw) throw new WebhookVerificationError('missing_fields');
    const settled = params.vnp_ResponseCode === '00' && params.vnp_TransactionStatus === '00';
    return {
      providerEventId: params.vnp_TransactionNo ? `vnp_${params.vnp_TransactionNo}` : `vnp_${txnRef}_${params.vnp_ResponseCode ?? 'na'}`,
      providerRef: txnRef,
      status: settled ? 'settled' : 'failed',
      amountMinor: String(BigInt(amountRaw) / 100n),
      currency: 'VND',
      occurredAt: new Date(),
    };
  }
}

// ----------------------------------------------------------------- MoMo

export interface MoMoConfig {
  partnerCode: string;
  accessKey: string;
  secretKey: string;
  sandbox: boolean;
}

const MOMO_HOST = { sandbox: 'https://test-payment.momo.vn', production: 'https://payment.momo.vn' } as const;

/**
 * MoMo (captureWallet). Creating a payment needs a signed server call, so
 * this class exposes pure builders/verifiers and the API route performs
 * the HTTP call itself. Amounts are plain dong, matching the platform's
 * VND minor unit 1:1.
 */
export class MoMoProvider {
  readonly name = 'momo';
  readonly sandbox: boolean;
  constructor(private readonly cfg: MoMoConfig) {
    this.sandbox = cfg.sandbox;
  }

  static newOrderRef(): string {
    return `MM${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  }

  get createEndpoint(): string {
    const host = this.cfg.sandbox ? MOMO_HOST.sandbox : MOMO_HOST.production;
    return `${host}/v2/gateway/api/create`;
  }

  /** Signed body for the create call; requestId/orderId derive from our ref. */
  buildCreateBody(input: { orderRef: string; amountMinor: string; redirectUrl: string; ipnUrl: string }): Record<string, string | number | boolean> {
    const raw = [
      `accessKey=${this.cfg.accessKey}`,
      `amount=${input.amountMinor}`,
      'extraData=',
      `ipnUrl=${input.ipnUrl}`,
      `orderId=${input.orderRef}`,
      'orderInfo=webmaket order payment',
      `partnerCode=${this.cfg.partnerCode}`,
      `redirectUrl=${input.redirectUrl}`,
      `requestId=${input.orderRef}`,
      'requestType=captureWallet',
    ].join('&');
    return {
      partnerCode: this.cfg.partnerCode,
      partnerName: 'webmaket',
      storeId: 'webmaket',
      requestId: input.orderRef,
      amount: Number(input.amountMinor),
      orderId: input.orderRef,
      orderInfo: 'webmaket order payment',
      redirectUrl: input.redirectUrl,
      ipnUrl: input.ipnUrl,
      lang: 'vi',
      autoCapture: true,
      extraData: '',
      requestType: 'captureWallet',
      signature: hmacHex('sha256', this.cfg.secretKey, raw),
    };
  }

  /** Verify an IPN JSON body and normalize it. Throws on a bad signature. */
  verifyIpn(rawBody: string): NormalizedEvent {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const raw = [
      `accessKey=${this.cfg.accessKey}`,
      `amount=${str(p.amount)}`,
      `extraData=${str(p.extraData)}`,
      `message=${str(p.message)}`,
      `orderId=${str(p.orderId)}`,
      `orderInfo=${str(p.orderInfo)}`,
      `orderType=${str(p.orderType)}`,
      `partnerCode=${str(p.partnerCode)}`,
      `payType=${str(p.payType)}`,
      `requestId=${str(p.requestId)}`,
      `responseTime=${str(p.responseTime)}`,
      `resultCode=${str(p.resultCode)}`,
      `transId=${str(p.transId)}`,
    ].join('&');
    const provided = str(p.signature);
    if (!provided || !safeEqual(hmacHex('sha256', this.cfg.secretKey, raw), provided)) {
      throw new WebhookVerificationError('bad_signature');
    }
    if (str(p.partnerCode) !== this.cfg.partnerCode) throw new WebhookVerificationError('wrong_merchant');
    const orderId = str(p.orderId);
    if (!orderId) throw new WebhookVerificationError('missing_fields');
    return {
      providerEventId: str(p.transId) ? `momo_${str(p.transId)}` : `momo_${orderId}_${str(p.resultCode)}`,
      providerRef: orderId,
      status: Number(p.resultCode) === 0 ? 'settled' : 'failed',
      amountMinor: str(p.amount),
      currency: 'VND',
      occurredAt: new Date(),
    };
  }
}
