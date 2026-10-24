import type { Metadata } from 'next';
import type { Locale } from '@3t/i18n';
import { ContentPageView, contentPageMetadata } from '@/components/content-page';

type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return contentPageMetadata('how-it-works', (await params).locale);
}
/** P05 — how it works. */
export default async function HowItWorks({ params }: Props) {
  return <ContentPageView slug="how-it-works" locale={(await params).locale} />;
}
