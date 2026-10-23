import vi from '../locales/vi.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

export type Locale = 'vi' | 'en';

export interface LocaleInfo {
  code: Locale;
  displayNameNative: string;
  direction: 'ltr' | 'rtl';
  enabled: boolean;
  fallbackLocale: Locale | null;
}

/** Locale registry (docs/07 §4). Fallback graph must not contain cycles. */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'vi', displayNameNative: 'Tiếng Việt', direction: 'ltr', enabled: true, fallbackLocale: null },
  { code: 'en', displayNameNative: 'English', direction: 'ltr', enabled: true, fallbackLocale: 'vi' },
];

export const DEFAULT_LOCALE: Locale = 'vi';

export const MESSAGES: Record<Locale, Record<string, string>> = { vi, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.some((l) => l.enabled && l.code === value);
}

/**
 * Locale priority: explicit parameter → user setting → Accept-Language → vi (docs/04 §1).
 */
export function negotiateLocale(opts: {
  explicit?: string | null | undefined;
  userPreference?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}): Locale {
  if (isLocale(opts.explicit)) return opts.explicit;
  if (isLocale(opts.userPreference)) return opts.userPreference;
  if (opts.acceptLanguage) {
    const ranked = opts.acceptLanguage
      .split(',')
      .map((part, index) => {
        const [tag = '', ...params] = part.trim().split(';');
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        const quality = q ? Number(q.slice(2)) : 1;
        return { base: tag.toLowerCase().split('-')[0] ?? '', quality: Number.isFinite(quality) ? quality : 0, index };
      })
      .filter((x) => x.quality > 0)
      .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const item of ranked) if (isLocale(item.base)) return item.base;
  }
  return DEFAULT_LOCALE;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholders(message: string): string[] {
  return [...message.matchAll(PLACEHOLDER)].map((m) => m[1] as string).sort();
}

/**
 * Translate a semantic key. Falls back requested locale → registry fallback → key.
 * Values are interpolated as plain text; callers render the result as text, never HTML.
 */
export function translate(locale: Locale, key: string, params: Record<string, string | number> = {}): string {
  let current: Locale | null = locale;
  const seen = new Set<Locale>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = MESSAGES[current][key];
    if (message !== undefined) {
      return message.replace(PLACEHOLDER, (whole, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
      );
    }
    current = LOCALES.find((l) => l.code === current)?.fallbackLocale ?? null;
  }
  return key;
}

export interface Money {
  amount_minor: string;
  currency: string;
}

const CURRENCY_EXPONENT: Record<string, number> = { VND: 0, USD: 2 };

/** Format integer minor units without converting through float for exponent 0 currencies. */
export function formatMoney(money: Money, locale: Locale): string {
  const exponent = CURRENCY_EXPONENT[money.currency] ?? 0;
  const minor = BigInt(money.amount_minor);
  const intlLocale = locale === 'vi' ? 'vi-VN' : 'en-US';
  const formatter = new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
  if (exponent === 0) return formatter.format(minor);
  const divisor = 10n ** BigInt(exponent);
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  const decimal = `${sign}${abs / divisor}.${(abs % divisor).toString().padStart(exponent, '0')}`;
  return formatter.format(decimal as unknown as number);
}

export function formatDateTime(iso: string, locale: Locale, timeZone = 'Asia/Ho_Chi_Minh'): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}
