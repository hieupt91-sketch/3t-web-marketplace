import Link from 'next/link';
import { translate } from '@3t/i18n';
import { requestLocale } from '@/lib/locale-server';

export default async function NotFound() {
  const locale = await requestLocale();
  return (
    <main id="main" className="container container--form">
      <h1>{translate(locale, 'ui.not_found.title')}</h1>
      <p className="muted">{translate(locale, 'ui.not_found.body')}</p>
      <Link className="button" href={`/${locale}`}>
        {translate(locale, 'ui.not_found.home')}
      </Link>
    </main>
  );
}
