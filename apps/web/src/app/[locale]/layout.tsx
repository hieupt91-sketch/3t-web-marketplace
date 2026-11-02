import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isLocale } from '@3t/i18n';
import { SiteFooter, SiteHeader } from '@/components/site-header';

export default async function PublicLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <>
      <SiteHeader publicLocale={locale} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
