import { describe, expect, it } from 'vitest';
import { MockPaymentProvider, WebhookVerificationError } from './payment.ts';

const provider = new MockPaymentProvider('test-secret', 'http://localhost:4000');

describe('MockPaymentProvider', () => {
  it('round-trips a signed event', () => {
    const signed = provider.signEvent({ providerRef: 'ref1', status: 'settled', amountMinor: '1500000', currency: 'VND' });
    const event = provider.verifyWebhook(signed.body, signed.headers);
    expect(event).toMatchObject({ providerRef: 'ref1', status: 'settled', amountMinor: '1500000', currency: 'VND' });
  });

  it('rejects a tampered body, a bad signature and a skewed timestamp', () => {
    const signed = provider.signEvent({ providerRef: 'ref2', status: 'settled', amountMinor: '100', currency: 'VND' });
    expect(() => provider.verifyWebhook(signed.body.replace('100', '999'), signed.headers)).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(signed.body, { ...signed.headers, 'x-mock-signature': 'v1=00' })).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(signed.body, { ...signed.headers, 'x-mock-timestamp': '1' })).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(signed.body, {})).toThrow(WebhookVerificationError);
  });

  it('rejects a signature from a different secret', () => {
    const other = new MockPaymentProvider('other-secret', 'http://localhost:4000');
    const signed = other.signEvent({ providerRef: 'ref3', status: 'settled', amountMinor: '1', currency: 'VND' });
    expect(() => provider.verifyWebhook(signed.body, signed.headers)).toThrow(WebhookVerificationError);
  });
});
