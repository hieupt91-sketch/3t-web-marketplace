import { translate, type Locale } from '@3t/i18n';
import type { TemplateSummary } from './api-server';

/** Storefront brand name (matches the metadata title template and the seeded platform brand). */
export const SITE_NAME = 'Web Marketplace';

/**
 * Canonical public origin for absolute SEO URLs (sitemap, robots, OG, JSON-LD, llms.txt).
 * PUBLIC_BASE_URL wins; PORTAL_ORIGIN is the production fallback because the web container
 * already receives it via deploy/.env. Never a request Host header (untrusted for canonicals).
 */
export function siteBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? process.env.PORTAL_ORIGIN ?? 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

/** Absolutize a site-relative path (e.g. a preview_image API path) against the public origin. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** hreflang alternates for a locale-prefixed path, e.g. languageAlternates('/templates/x'). */
export function languageAlternates(path: string): Record<string, string> {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return { vi: `/vi${clean}`, en: `/en${clean}`, 'x-default': `/vi${clean}` };
}

/** Same exponent table @3t/i18n formatMoney uses; unknown currencies are treated as exponent 0 there. */
const CURRENCY_EXPONENT: Record<string, number> = { VND: 0, USD: 2 };

/** Integer minor units -> major-unit number for schema.org prices; null when not a positive amount. */
export function priceMajor(amountMinor: string, currency: string): number | null {
  if (!/^\d+$/.test(amountMinor)) return null;
  const exponent = CURRENCY_EXPONENT[currency] ?? 0;
  const value = Number(amountMinor) / 10 ** exponent;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The cheapest published starting price of a template — the same "from" figure TemplateCard shows. */
export function cheapestOffer(template: TemplateSummary): { price: number; currency: string } | null {
  let best: { price: number; currency: string; minor: bigint } | null = null;
  for (const entry of template.starting_prices) {
    const price = priceMajor(entry.amount_minor, entry.currency);
    if (price === null) continue;
    const minor = BigInt(entry.amount_minor);
    if (!best || minor < best.minor) best = { price, currency: entry.currency, minor };
  }
  return best ? { price: best.price, currency: best.currency } : null;
}

export function organizationJsonLd(locale: Locale): Record<string, unknown> {
  const base = siteBaseUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: `${base}/`,
    logo: `${base}/logo.svg`,
    description: translate(locale, 'ui.meta.description'),
  };
}

export function websiteJsonLd(locale: Locale): Record<string, unknown> {
  const base = siteBaseUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: `${base}/`,
    inLanguage: locale === 'vi' ? 'vi-VN' : 'en-US',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${base}/${locale}/templates?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function productJsonLd(template: TemplateSummary, locale: Locale): Record<string, unknown> {
  const pageUrl = `${siteBaseUrl()}/${locale}/templates/${template.slug}`;
  const offer = cheapestOffer(template);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: template.title,
    ...(template.summary ? { description: template.summary } : {}),
    ...(template.preview_image ? { image: absoluteUrl(template.preview_image) } : {}),
    url: pageUrl,
    ...(offer
      ? {
          offers: {
            '@type': 'Offer',
            url: pageUrl,
            price: offer.price,
            priceCurrency: offer.currency,
            availability: 'https://schema.org/InStock',
          },
        }
      : {}),
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]): Record<string, unknown> {
  const base = siteBaseUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${base}${item.path}`,
    })),
  };
}

export function itemListJsonLd(templates: TemplateSummary[], locale: Locale): Record<string, unknown> {
  const base = siteBaseUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: templates.map((template, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: template.title,
      url: `${base}/${locale}/templates/${template.slug}`,
    })),
  };
}
