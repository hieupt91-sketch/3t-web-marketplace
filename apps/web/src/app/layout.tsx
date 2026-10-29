import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { translate } from '@3t/i18n';
import { LocaleProvider } from '@/lib/i18n';
import { requestLocale } from '@/lib/locale-server';
import { ContactWidget } from '@/components/contact-widget';
import { QuickAssistant } from '@/components/quick-assistant';
import { JsonLd } from '@/components/json-ld';
import { SITE_NAME, organizationJsonLd, siteBaseUrl, websiteJsonLd } from '@/lib/seo';
import '@/styles/globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const base = siteBaseUrl();
  const description = translate(locale, 'ui.meta.description');
  const ogTitle = translate(locale, 'ui.home.meta_title');
  return {
    metadataBase: new URL(base),
    title: { default: 'Web Marketplace', template: '%s — Web Marketplace' },
    description,
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      url: `${base}/${locale}`,
      title: ogTitle,
      description,
      locale: locale === 'vi' ? 'vi_VN' : 'en_US',
      alternateLocale: [locale === 'vi' ? 'en_US' : 'vi_VN'],
      images: [{ url: '/hero/hero-showcase.jpg', alt: SITE_NAME }],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description,
      images: ['/hero/hero-showcase.jpg'],
    },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale}>
      <body>
        <JsonLd data={[organizationJsonLd(locale), websiteJsonLd(locale)]} />
        <a className="skip-link" href="#main">
          {translate(locale, 'ui.skip_to_content')}
        </a>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
        <ContactWidget locale={locale} />
        <QuickAssistant locale={locale} />
      </body>
    </html>
  );
}
