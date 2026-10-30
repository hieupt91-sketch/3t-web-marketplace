import { describe, expect, it } from 'vitest';
import { BankTransferProvider, MockPaymentProvider, WebhookVerificationError } from './payment.ts';

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

describe('BankTransferProvider', () => {
  const provider = new BankTransferProvider('hub-key-123', 'https://webmaket.com');
  const auth = { authorization: 'Apikey hub-key-123' };

  it('creates a session whose reference is the transfer content code', () => {
    const s = provider.createSession({ orderId: 'o1', amountMinor: '499000', currency: 'VND', returnUrl: '', expiresAt: new Date() });
    expect(s.providerRef).toMatch(/^WM[0-9A-F]{10}$/);
    expect(provider.sandbox).toBe(false);
  });

  it('settles an incoming SePay-shaped report matched by code and amount', () => {
    const body = JSON.stringify({ id: 987, gateway: 'Vietcombank', transactionDate: '2026-10-30 10:00:00', accountNumber: '0123', code: 'WM3F9A2B7C4D', content: 'WM3F9A2B7C4D thanh toan', transferType: 'in', transferAmount: 499000, referenceCode: 'FT123' });
    const event = provider.verifyWebhook(body, auth);
    expect(event).toMatchObject({ providerEventId: '987', providerRef: 'WM3F9A2B7C4D', status: 'settled', amountMinor: '499000', currency: 'VND' });
  });

  it('extracts the code from free-text content when the hub sends none', () => {
    const body = JSON.stringify({ id: 988, content: 'khach chuyen wm3f9a2b7c4d cam on', transferType: 'in', transferAmount: 1000 });
    expect(provider.verifyWebhook(body, auth).providerRef).toBe('WM3F9A2B7C4D');
  });

  it('never settles outgoing transfers or codeless reports', () => {
    const out = JSON.stringify({ id: 989, code: 'WM3F9A2B7C4D', transferType: 'out', transferAmount: 499000 });
    expect(provider.verifyWebhook(out, auth)).toMatchObject({ providerRef: '', status: 'pending' });
    const noCode = JSON.stringify({ id: 990, content: 'chuyen khoan thuong', transferType: 'in', transferAmount: 499000 });
    expect(provider.verifyWebhook(noCode, auth).providerRef).toBe('');
  });

  it('rejects a wrong hub key and any key when none is configured', () => {
    const body = JSON.stringify({ id: 991, code: 'WM3F9A2B7C4D', transferType: 'in', transferAmount: 1 });
    expect(() => provider.verifyWebhook(body, { authorization: 'Apikey wrong' })).toThrow();
    expect(() => new BankTransferProvider('', 'https://webmaket.com').verifyWebhook(body, auth)).toThrow();
  });

  it('accepts the generic hub shape too', () => {
    const body = JSON.stringify({ transaction_id: 'tx-1', code: 'WM3F9A2B7C4D', amount: 250000 });
    expect(provider.verifyWebhook(body, { 'x-hub-secret': 'hub-key-123' })).toMatchObject({ providerEventId: 'tx-1', status: 'settled', amountMinor: '250000' });
  });
});
