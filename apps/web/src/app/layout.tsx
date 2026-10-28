import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { translate } from '@3t/i18n';
import { LocaleProvider } from '@/lib/i18n';
import { requestLocale } from '@/lib/locale-server';
import { ContactWidget } from '@/components/contact-widget';
import { QuickAssistant } from '@/components/quick-assistant';
import '@/styles/globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: { default: 'Web Marketplace', template: '%s — Web Marketplace' },
    description: translate(locale, 'ui.meta.description'),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale}>
      <body>
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
