import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchHelpIndex } from '@/lib/content-server';

type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: translate(locale, 'ui.help.title'), alternates: { canonical: `/${locale}/help` } };
}

/** P06 — help index. */
export default async function HelpIndex({ params }: Props) {
  const { locale } = await params;
  const t = (k: string) => translate(locale, k);
  const result = await fetchHelpIndex(locale);
  return (
    <div className="container container--form stack">
      <h1>{t('ui.help.title')}</h1>
      {!result.ok ? (
        <div className="alert alert--error" role="alert"><p>{t('ui.content.unavailable')}</p></div>
      ) : result.data.length === 0 ? (
        <p className="muted">{t('ui.help.empty')}</p>
      ) : (
        <ul className="stack">
          {result.data.map((p) => <li key={p.slug}><Link href={`/${locale}/help/${p.slug}`}>{p.title}</Link></li>)}
        </ul>
      )}
    </div>
  );
}
