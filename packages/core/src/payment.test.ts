import { describe, expect, it } from 'vitest';
import { BankTransferProvider, CassoHubProvider, MockPaymentProvider, WebhookVerificationError, manualTransferRef, usdAmountFor } from './payment.ts';

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

describe('manual transfer helpers (PayPal / USD)', () => {
  it('generates prefixed, unique per-order references', () => {
    const a = manualTransferRef('PP');
    const b = manualTransferRef('US');
    expect(a).toMatch(/^PP[0-9A-F]{10}$/);
    expect(b).toMatch(/^US[0-9A-F]{10}$/);
    expect(manualTransferRef('PP')).not.toBe(a);
  });

  it('quotes USD from a VND total at the owner rate, rounded half-up at the cent', () => {
    expect(usdAmountFor('199999', 26000)).toBe('7.69');
    expect(usdAmountFor('26000', 26000)).toBe('1.00');
    expect(usdAmountFor('13000', 26000)).toBe('0.50');
    expect(usdAmountFor('12987', 26000)).toBe('0.50'); // 0.4995 -> 0.50
    expect(usdAmountFor('100000000', 25400)).toBe('3937.01');
    expect(usdAmountFor('500000', 0)).toBe('0.00');
  });
});

describe('CassoHubProvider', () => {
  const provider = new CassoHubProvider('casso-secret-1');
  const auth = { 'secure-token': 'casso-secret-1' };

  it('settles a batch: matching transactions become settled events with namespaced ids', () => {
    const body = JSON.stringify({
      error: 0,
      data: [
        { id: 6785, tid: 'FT1', description: 'WM3F9A2B7C4D thanh toan don hang', amount: 499000, cusum_balance: 20079000, when: '2026-10-31 09:15:00', bank_sub_acc_id: '0123456789' },
        { id: 6786, tid: 'FT2', description: 'chuyen khoan thuong', amount: 50000, when: '2026-10-31 09:16:00' },
      ],
    });
    const events = provider.verifyWebhookBatch(body, auth);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ providerEventId: 'casso:6785', providerRef: 'WM3F9A2B7C4D', status: 'settled', amountMinor: '499000', currency: 'VND' });
    expect(events[1]).toMatchObject({ providerEventId: 'casso:6786', providerRef: '', status: 'pending' });
  });

  it('extracts the code case-insensitively and never settles outgoing money', () => {
    const body = JSON.stringify({
      error: 0,
      data: [
        { id: 6790, description: 'nhan wm3f9a2b7c4d cam on', amount: 1000 },
        { id: 6791, description: 'WM3F9A2B7C4D rut tien', amount: -499000 },
      ],
    });
    const events = provider.verifyWebhookBatch(body, auth);
    expect(events[0]).toMatchObject({ providerRef: 'WM3F9A2B7C4D', status: 'settled' });
    expect(events[1]).toMatchObject({ providerRef: '', status: 'pending' });
  });

  it('acknowledges a non-zero error envelope with no events', () => {
    expect(provider.verifyWebhookBatch(JSON.stringify({ error: 1, data: [] }), auth)).toEqual([]);
  });

  it('rejects a wrong secure token, a missing one, and any token when none is configured', () => {
    const body = JSON.stringify({ error: 0, data: [{ id: 1, description: 'WM3F9A2B7C4D', amount: 1 }] });
    expect(() => provider.verifyWebhookBatch(body, { 'secure-token': 'wrong' })).toThrow();
    expect(() => provider.verifyWebhookBatch(body, {})).toThrow();
    expect(() => new CassoHubProvider('').verifyWebhookBatch(body, auth)).toThrow();
  });
});
