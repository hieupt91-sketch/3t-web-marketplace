import { describe, expect, it } from 'vitest';
import { formatMoney, negotiateLocale, translate } from './index.ts';

describe('negotiateLocale', () => {
  it('prefers explicit, then user, then Accept-Language, then vi', () => {
    expect(negotiateLocale({ explicit: 'en', userPreference: 'vi' })).toBe('en');
    expect(negotiateLocale({ explicit: 'fr', userPreference: 'en' })).toBe('en');
    expect(negotiateLocale({ acceptLanguage: 'fr-FR, en-US;q=0.8, vi;q=0.5' })).toBe('en');
    expect(negotiateLocale({ acceptLanguage: 'en;q=0, vi;q=0.1' })).toBe('vi');
    expect(negotiateLocale({})).toBe('vi');
  });
});

describe('translate', () => {
  it('interpolates placeholders as text and falls back to key', () => {
    expect(translate('en', 'demo.expired')).toBe('This demo session has expired.');
    expect(translate('vi', 'no.such.key')).toBe('no.such.key');
    expect(translate('en', 'import.size_limit', { size: '100 MiB' })).toContain('100 MiB');
  });
});

describe('formatMoney', () => {
  it('keeps VND integer value regardless of locale', () => {
    const money = { amount_minor: '1500000', currency: 'VND' };
    expect(formatMoney(money, 'vi').replace(/\D/g, '')).toBe('1500000');
    expect(formatMoney(money, 'en').replace(/\D/g, '')).toBe('1500000');
  });
});
