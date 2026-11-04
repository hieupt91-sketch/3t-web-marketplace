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
/**
 * The useful bits of a MoMo create-payment response: the hosted pay URL
 * plus MoMo's own QR payload (qrCodeUrl), which the MoMo app scans
 * directly. Returns null when the create did not succeed.
 */
export function parseMoMoCreateResponse(json: Record<string, unknown>): { payUrl: string; qrPayload: string | null } | null {
  if (json.resultCode !== 0 || typeof json.payUrl !== 'string' || json.payUrl === '') return null;
  return { payUrl: json.payUrl, qrPayload: typeof json.qrCodeUrl === 'string' && json.qrCodeUrl !== '' ? json.qrCodeUrl : null };
}

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

// ---------------------------------------------------------------- payOS

export interface PayosConfig {
  clientId: string;
  apiKey: string;
  checksumKey: string;
}

const PAYOS_HOST = 'https://api-merchant.payos.vn';

/** Shallow key sort — the shape payOS's documented webhook signer uses
 *  when it stringifies object values. */
function sortKeysShallow(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * payOS webhook signing string: the data object's entries sorted by key
 * ascending, undefined values skipped, null rendered as an empty string,
 * arrays and plain objects JSON-stringified with their keys sorted, all
 * joined as `key=value` pairs with '&'.
 */
export function payosWebhookQueryString(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${key}=`);
    } else if (Array.isArray(value)) {
      const normalized = value.map((el) =>
        el !== null && typeof el === 'object' && !Array.isArray(el) ? sortKeysShallow(el as Record<string, unknown>) : el,
      );
      parts.push(`${key}=${JSON.stringify(normalized)}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(sortKeysShallow(value as Record<string, unknown>))}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join('&');
}

/**
 * The useful bits of a payOS create-payment-link response: the hosted
 * checkout URL plus the VietQR payload the buyer's banking app scans.
 * Returns null when the create did not succeed (code !== "00").
 */
export function parsePayosCreateResponse(json: Record<string, unknown>): { checkoutUrl: string; qrCode: string; paymentLinkId: string; bin: string; accountNumber: string; accountName: string } | null {
  if (json.code !== '00') return null;
  const d = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const checkoutUrl = str(d.checkoutUrl);
  const paymentLinkId = str(d.paymentLinkId);
  if (checkoutUrl === '' || paymentLinkId === '') return null;
  return {
    checkoutUrl,
    qrCode: str(d.qrCode),
    paymentLinkId,
    bin: str(d.bin),
    accountNumber: str(d.accountNumber),
    accountName: str(d.accountName),
  };
}

/**
 * payOS (api-merchant.payos.vn). Amounts are plain dong, matching the
 * platform's VND minor unit 1:1. Creating a payment link is a signed
 * server call — the signature covers only the five documented fields, in
 * the documented order — so the class exposes the builder plus a create
 * method taking an injectable fetch. Webhooks are HMAC-signed over the
 * sorted data object; the paymentLinkId is the attempt reference and,
 * with the bank transaction reference, the idempotent event id.
 */
export class PayosProvider {
  readonly name = 'payos';

  constructor(private readonly cfg: PayosConfig) {}

  get createEndpoint(): string {
    return `${PAYOS_HOST}/v2/payment-requests`;
  }

  /** Signature for the create call: exactly the documented field string. */
  buildCreateSignature(input: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }): string {
    const data = `amount=${input.amount}&cancelUrl=${input.cancelUrl}&description=${input.description}&orderCode=${input.orderCode}&returnUrl=${input.returnUrl}`;
    return hmacHex('sha256', this.cfg.checksumKey, data);
  }

  /** Create a payment link; throws with the gateway's desc on failure. */
  async createPaymentLink(
    input: { orderCode: number; amountMinor: string; description: string; returnUrl: string; cancelUrl: string; expiredAt?: number },
    fetchFn: typeof fetch = fetch,
  ): Promise<NonNullable<ReturnType<typeof parsePayosCreateResponse>>> {
    const amount = Number(input.amountMinor);
    const body: Record<string, unknown> = {
      orderCode: input.orderCode,
      amount,
      description: input.description,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      ...(input.expiredAt !== undefined ? { expiredAt: input.expiredAt } : {}),
      signature: this.buildCreateSignature({ amount, cancelUrl: input.cancelUrl, description: input.description, orderCode: input.orderCode, returnUrl: input.returnUrl }),
    };
    const res = await fetchFn(this.createEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    const parsed = parsePayosCreateResponse(json);
    if (!parsed) {
      throw new Error(`payos create failed: ${typeof json.desc === 'string' && json.desc !== '' ? json.desc : 'unknown error'}`);
    }
    return parsed;
  }

  /** Verify a webhook body and normalize it. Throws on a bad signature. */
  verifyWebhook(rawBody: string): NormalizedEvent {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const data = (typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data) ? p.data : null) as Record<string, unknown> | null;
    const provided = str(p.signature);
    if (!data || provided === '') throw new WebhookVerificationError('missing_fields');
    const expected = hmacHex('sha256', this.cfg.checksumKey, payosWebhookQueryString(data));
    if (!safeEqual(expected, provided.toLowerCase())) {
      throw new WebhookVerificationError('bad_signature');
    }
    const paymentLinkId = str(data.paymentLinkId);
    if (paymentLinkId === '') throw new WebhookVerificationError('missing_fields');
    // A payment counts as settled only when every layer reports success.
    const settled = p.success === true && p.code === '00' && str(data.code) === '00';
    const reference = str(data.reference);
    return {
      providerEventId: `payos_${paymentLinkId}_${reference !== '' ? reference : str(data.orderCode)}`,
      providerRef: paymentLinkId,
      status: settled ? 'settled' : 'failed',
      amountMinor: str(data.amount),
      currency: str(data.currency) !== '' ? str(data.currency) : 'VND',
      occurredAt: new Date(),
    };
  }
}
