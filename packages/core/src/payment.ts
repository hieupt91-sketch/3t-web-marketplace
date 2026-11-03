import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Payment provider abstraction (docs/08 §1). A concrete provider is chosen at the integration
 * milestone; until then the sandbox MockProvider is used, clearly labelled, and never moves real
 * money. The platform always verifies settlement from a signed event, never from a client redirect.
 */
export interface PaymentSession {
  providerRef: string;
  /** Where the buyer completes payment. For the mock this is a sandbox endpoint on this API. */
  payUrl: string;
  expiresAt: Date;
}

export interface NormalizedEvent {
  providerEventId: string;
  providerRef: string;
  /** Mapped to a common vocabulary regardless of provider wording. */
  status: 'settled' | 'failed' | 'pending';
  amountMinor: string;
  currency: string;
  occurredAt: Date;
}

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

/** Normalized provider refund event (AT-56): a refund settles exactly once. */
export interface NormalizedRefundEvent {
  providerEventId: string;
  refundRef: string;
  status: 'confirmed' | 'failed';
  amountMinor: string;
  currency: string;
  occurredAt: Date;
}

export interface PaymentProvider {
  readonly name: string;
  readonly sandbox: boolean;
  createSession(input: { orderId: string; amountMinor: string; currency: string; returnUrl: string; expiresAt: Date }): PaymentSession;
  /** Verify the raw request body and headers; returns the normalized event or throws. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): NormalizedEvent;
}

const SIG_HEADER = 'x-mock-signature';
const TS_HEADER = 'x-mock-timestamp';
const MAX_SKEW_SECONDS = 300;

export class WebhookVerificationError extends Error {}

/**
 * Sandbox provider. Settlement is produced by signing an event with a shared secret, so the real
 * webhook verification path (HMAC + timestamp + dedupe) is exercised end to end in tests and dev.
 */
/** One EMVCo TLV field: 2-digit id + 2-digit length + value. */
function emvField(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as 4 uppercase hex chars. */
function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * VietQR payload (NAPAS/EMVCo) for a transfer to a bank account, with the
 * amount and the order content code baked in: the buyer's banking app fills
 * both from the scan, so the incoming transfer carries the exact amount and
 * the content code the hub (Casso/SePay) matches on. The merchant account
 * block is the standard VietQR shape: AID A000000727, the beneficiary
 * sub-block (bank BIN + account number), service QRIBFTTA (account transfer
 * with amount). The content code rides in additional-data field 62/01 (bill
 * number), which banking apps surface as the transfer description.
 */
export function buildVietQrPayload(input: { bankBin: string; accountNumber: string; amountMinor: string; content: string }): string {
  const beneficiary = emvField('00', input.bankBin) + emvField('01', input.accountNumber);
  const merchantAccount = emvField('00', 'A000000727') + emvField('01', beneficiary) + emvField('02', 'QRIBFTTA');
  const body =
    emvField('00', '01') +
    emvField('01', '12') +
    emvField('38', merchantAccount) +
    emvField('53', '704') +
    emvField('54', input.amountMinor) +
    emvField('58', 'VN') +
    emvField('62', emvField('01', input.content)) +
    '6304';
  return body + crc16Ccitt(body);
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly sandbox = true;
  constructor(
    private readonly secret: string,
    private readonly apiBaseUrl: string,
  ) {}

  createSession(input: { orderId: string; amountMinor: string; currency: string; returnUrl: string; expiresAt: Date }): PaymentSession {
    const providerRef = `mockpay_${randomUUID()}`;
    return { providerRef, payUrl: `${this.apiBaseUrl}/api/v1/payments/mock/${providerRef}/confirm`, expiresAt: input.expiresAt };
  }

  /** Build a signed settled/failed event (used by the sandbox confirm endpoint and by tests). */
  signEvent(event: { providerRef: string; status: 'settled' | 'failed'; amountMinor: string; currency: string; eventId?: string }): SignedWebhook {
    const body = JSON.stringify({
      event_id: event.eventId ?? `evt_${randomUUID()}`,
      provider_ref: event.providerRef,
      status: event.status,
      amount_minor: event.amountMinor,
      currency: event.currency,
      occurred_at: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
    return { body, headers: { 'content-type': 'application/json', [TS_HEADER]: timestamp, [SIG_HEADER]: `v1=${signature}` } };
  }

  /** Build a signed refund settled/failed event (sandbox confirm endpoint and tests). */
  signRefundEvent(event: { refundRef: string; status: 'confirmed' | 'failed'; amountMinor: string; currency: string; eventId?: string }): SignedWebhook {
    const body = JSON.stringify({
      kind: 'refund',
      event_id: event.eventId ?? `evt_${randomUUID()}`,
      refund_ref: event.refundRef,
      status: event.status,
      amount_minor: event.amountMinor,
      currency: event.currency,
      occurred_at: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.secret).update(`${timestamp}.${body}`).digest('hex');
    return { body, headers: { 'content-type': 'application/json', [TS_HEADER]: timestamp, [SIG_HEADER]: `v1=${signature}` } };
  }

  /** Verify a signed refund event; same HMAC + timestamp scheme as payment webhooks. */
  verifyRefundWebhook(rawBody: string, headers: Record<string, string | undefined>): NormalizedRefundEvent {
    const timestamp = headers[TS_HEADER];
    const signature = headers[SIG_HEADER];
    if (!timestamp || !signature || !signature.startsWith('v1=')) throw new WebhookVerificationError('missing_signature');
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) throw new WebhookVerificationError('timestamp_skew');
    const expected = createHmac('sha256', this.secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const provided = signature.slice(3);
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(provided, 'hex');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) throw new WebhookVerificationError('bad_signature');
    let parsed: { kind?: string; event_id?: string; refund_ref?: string; status?: string; amount_minor?: string; currency?: string; occurred_at?: string };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    if (parsed.kind !== 'refund' || !parsed.event_id || !parsed.refund_ref || !parsed.amount_minor || !parsed.currency) throw new WebhookVerificationError('missing_fields');
    if (parsed.status !== 'confirmed' && parsed.status !== 'failed') throw new WebhookVerificationError('invalid_status');
    return {
      providerEventId: parsed.event_id,
      refundRef: parsed.refund_ref,
      status: parsed.status,
      amountMinor: String(parsed.amount_minor),
      currency: parsed.currency,
      occurredAt: parsed.occurred_at ? new Date(parsed.occurred_at) : new Date(),
    };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): NormalizedEvent {
    const timestamp = headers[TS_HEADER];
    const signature = headers[SIG_HEADER];
    if (!timestamp || !signature || !signature.startsWith('v1=')) throw new WebhookVerificationError('missing_signature');
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) throw new WebhookVerificationError('timestamp_skew');
    const expected = createHmac('sha256', this.secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const provided = signature.slice(3);
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(provided, 'hex');
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) throw new WebhookVerificationError('bad_signature');
    let parsed: { event_id?: string; provider_ref?: string; status?: string; amount_minor?: string; currency?: string; occurred_at?: string };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    if (!parsed.event_id || !parsed.provider_ref || !parsed.amount_minor || !parsed.currency) throw new WebhookVerificationError('missing_fields');
    const status = parsed.status === 'settled' ? 'settled' : parsed.status === 'failed' ? 'failed' : 'pending';
    return {
      providerEventId: parsed.event_id,
      providerRef: parsed.provider_ref,
      status,
      amountMinor: String(parsed.amount_minor),
      currency: parsed.currency,
      occurredAt: parsed.occurred_at ? new Date(parsed.occurred_at) : new Date(),
    };
  }
}

/** Per-order reference for a manual transfer method (PayPal, USD bank
 *  transfer): a short prefix plus 10 hex chars, written by the buyer in
 *  the transfer note so staff can match the incoming money to the order.
 *  It doubles as the payment attempt's provider_ref. */
export function manualTransferRef(prefix: 'PP' | 'US'): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

/** USD amount to quote for a VND total at the owner's configured rate
 *  (VND per 1 USD, set in admin — never hard-coded). Returns a plain
 *  decimal string with exactly two fraction digits, rounded half-up at
 *  the cent. BigInt math keeps large totals exact. */
export function usdAmountFor(totalMinorVnd: string, rateVndPerUsd: number): string {
  const total = BigInt(totalMinorVnd);
  const rate = BigInt(Math.round(rateVndPerUsd));
  if (rate <= 0n) return '0.00';
  const cents = (total * 100n + rate / 2n) / rate;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** Rate actually quoted to USD buyers: the owner's base rate (pegged to
 *  the State Bank of Vietnam central rate, maintained by hand in admin)
 *  plus an adjustable fee percentage, which may be negative (a discount).
 *  The fee is quantized to 2 decimals (basis-point style) before applying
 *  so the integer result is stable for display and for the frozen quote.
 *  Returns 0 when the base rate is not a positive finite number or the
 *  fee is not finite — callers treat 0 as "no USD quote". */
export function usdAppliedRate(baseRate: number, feePercent: number): number {
  if (!Number.isFinite(baseRate) || baseRate <= 0) return 0;
  if (!Number.isFinite(feePercent)) return 0;
  return Math.round(baseRate * (10000 + Math.round(feePercent * 100)) / 10000);
}

/**
 * Bank transfer settled through a transaction hub (SePay-compatible).
 *
 * The buyer transfers to the owner's bank account with a per-order content
 * code; the hub (which watches the bank account) posts the incoming
 * transaction to the platform webhook, authenticated by an API key the
 * owner configures in admin settings. The provider reference IS the
 * content code the buyer must write, so a hub report maps straight back
 * to the payment attempt. Amounts reported by hubs are whole dong, which
 * is exactly this platform's minor unit for VND.
 *
 * Payloads that are authentic but cannot settle anything (outgoing
 * transfers, missing code) normalize to a `pending` event with an empty
 * reference, which the settlement pipeline records and ignores — it must
 * never fail or settle a real attempt by accident.
 */
export class BankTransferProvider implements PaymentProvider {
  readonly name = 'bank_transfer';
  readonly sandbox = false;
  constructor(
    private readonly hubApiKey: string,
    private readonly portalOrigin: string,
  ) {}

  /** Content code the buyer writes in the transfer note: WM + 10 hex chars. */
  static newContentCode(): string {
    return `WM${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  }
  createSession(input: { orderId: string; amountMinor: string; currency: string; returnUrl: string; expiresAt: Date }): PaymentSession {
    return {
      providerRef: BankTransferProvider.newContentCode(),
      // There is no external pay page; the buyer stays on the portal pay
      // page, which renders the transfer instructions for this session.
      payUrl: `${this.portalOrigin}/checkout/orders/${input.orderId}/pay`,
      expiresAt: input.expiresAt,
    };
  }

  private authed(headers: Record<string, string | undefined>): boolean {
    if (!this.hubApiKey) return false;
    const expected = Buffer.from(this.hubApiKey);
    const candidates = [
      headers['authorization']?.replace(/^Apikey\s+/i, ''),
      headers['authorization']?.replace(/^Bearer\s+/i, ''),
      headers['x-hub-secret'],
    ];
    return candidates.some((raw) => {
      if (!raw) return false;
      const provided = Buffer.from(raw.trim());
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): NormalizedEvent {
    if (!this.authed(headers)) throw new WebhookVerificationError('bad_hub_key');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    const fallbackId = `hubevt_${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
    const eventId = String(parsed.id ?? parsed.transaction_id ?? parsed.referenceCode ?? fallbackId);
    const ignored: NormalizedEvent = {
      providerEventId: eventId,
      providerRef: '',
      status: 'pending',
      amountMinor: '0',
      currency: 'VND',
      occurredAt: new Date(),
    };
    // SePay shape: transferType tells direction; only incoming money settles.
    if (typeof parsed.transferType === 'string' && parsed.transferType !== 'in') return ignored;
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    let code = typeof parsed.code === 'string' ? parsed.code.trim().toUpperCase() : '';
    if (!/^(?:WM|WT)[0-9A-F]{10}$/.test(code)) {
      const found = content.toUpperCase().match(/(?:WM|WT)[0-9A-F]{10}/);
      code = found ? found[0] : '';
    }
    if (!code) return ignored;
    const rawAmount = parsed.transferAmount ?? parsed.amount_minor ?? parsed.amount;
    const amount = typeof rawAmount === 'number' ? Math.trunc(rawAmount) : Number.parseInt(String(rawAmount ?? ''), 10);
    if (!Number.isFinite(amount) || amount <= 0) return ignored;
    const occurred = typeof parsed.transactionDate === 'string' ? new Date(parsed.transactionDate) : new Date();
    return {
      providerEventId: eventId,
      providerRef: code,
      status: 'settled',
      amountMinor: String(amount),
      currency: 'VND',
      occurredAt: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
    };
  }
}

/**
 * Casso hub webhook (developer.casso.vn): Casso watches the owner's bank
 * account and POSTs every new transaction as `{ error: 0, data: [tx, ...] }`,
 * authenticated by a `secure-token` header whose value the owner chooses in
 * Casso's webhook config — the platform stores that same value as the bank
 * hub key, so one secret serves both hub kinds. One call can carry several
 * transactions, hence a batch verifier. Events settle through the SAME
 * bank_transfer pipeline as SePay reports (attempts are provider
 * 'bank_transfer'); Casso transaction ids are namespaced `casso:` so the
 * two hubs' ids can never collide in the dedupe table. Transactions that
 * cannot settle anything (money out, no order code) normalize to pending
 * events with an empty reference, which the pipeline records and ignores.
 */
export class CassoHubProvider {
  readonly name = 'casso';
  readonly sandbox = false;
  constructor(private readonly secureToken: string) {}

  private authed(headers: Record<string, string | undefined>): boolean {
    if (!this.secureToken) return false;
    const raw = headers['secure-token'];
    if (!raw) return false;
    const provided = Buffer.from(raw.trim());
    const expected = Buffer.from(this.secureToken);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  verifyWebhookBatch(rawBody: string, headers: Record<string, string | undefined>): NormalizedEvent[] {
    if (!this.authed(headers)) throw new WebhookVerificationError('bad_secure_token');
    let parsed: { error?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { error?: unknown; data?: unknown };
    } catch {
      throw new WebhookVerificationError('invalid_json');
    }
    // A non-zero error envelope carries no transactions; acknowledge it.
    if (parsed.error !== undefined && parsed.error !== null && Number(parsed.error) !== 0) return [];
    if (!Array.isArray(parsed.data)) throw new WebhookVerificationError('missing_data');
    return parsed.data.map((rawTx, index) => this.normalize(rawTx, rawBody, index));
  }

  private normalize(rawTx: unknown, rawBody: string, index: number): NormalizedEvent {
    const tx = (rawTx && typeof rawTx === 'object' ? rawTx : {}) as Record<string, unknown>;
    const fallbackId = `casso:hubevt_${createHash('sha256').update(`${rawBody}#${index}`).digest('hex').slice(0, 32)}`;
    const eventId = tx.id !== undefined && tx.id !== null && String(tx.id) !== '' ? `casso:${String(tx.id)}` : fallbackId;
    const ignored: NormalizedEvent = {
      providerEventId: eventId,
      providerRef: '',
      status: 'pending',
      amountMinor: '0',
      currency: 'VND',
      occurredAt: new Date(),
    };
    const rawAmount = typeof tx.amount === 'number' ? tx.amount : Number.parseFloat(String(tx.amount ?? ''));
    // Only incoming money settles: Casso reports withdrawals as negative amounts.
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) return ignored;
    const description = typeof tx.description === 'string' ? tx.description : '';
    const found = description.toUpperCase().match(/(?:WM|WT)[0-9A-F]{10}/);
    if (!found) return ignored;
    const when = typeof tx.when === 'string' ? new Date(tx.when.replace(' ', 'T')) : new Date();
    return {
      providerEventId: eventId,
      providerRef: found[0],
      status: 'settled',
      amountMinor: String(Math.trunc(rawAmount)),
      currency: 'VND',
      occurredAt: Number.isNaN(when.getTime()) ? new Date() : when,
    };
  }
}
