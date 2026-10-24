import type { Metadata } from 'next';
import type { Locale } from '@3t/i18n';
import { ContentPageView, contentPageMetadata } from '@/components/content-page';

type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return contentPageMetadata('partners', (await params).locale);
}
/** P07 — partners info (program itself is M6). */
export default async function Partners({ params }: Props) {
  return <ContentPageView slug="partners" locale={(await params).locale} />;
}
