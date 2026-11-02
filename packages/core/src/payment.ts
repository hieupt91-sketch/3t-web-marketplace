import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

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
