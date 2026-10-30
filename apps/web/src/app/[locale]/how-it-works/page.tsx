import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { ContentPageView, contentPageMetadata } from '@/components/content-page';

type Props = { params: Promise<{ locale: Locale }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return contentPageMetadata('how-it-works', (await params).locale);
}

/**
 * P05 — how it works. Opens with the two-path chooser (docs/12 §7): hosted with
 * webmaket's help, or download and self-host. The step-by-step article below is
 * the seeded CMS page; advanced infrastructure topics live in Help, not here.
 */
export default async function HowItWorks({ params }: Props) {
  const { locale } = await params;
  const t = (k: string) => translate(locale, k);
  const paths = [
    {
      key: 'a',
      title: t('ui.how.a_title'),
      steps: [t('ui.how.a_step1'), t('ui.how.a_step2'), t('ui.how.a_step3')],
      cta: { href: `/${locale}/templates?mode=hosted`, label: t('ui.how.a_cta') },
      secondary: null as { href: string; label: string } | null,
    },
    {
      key: 'b',
      title: t('ui.how.b_title'),
      steps: [t('ui.how.b_step1'), t('ui.how.b_step2'), t('ui.how.b_step3')],
      cta: { href: `/${locale}/templates?mode=selfhost`, label: t('ui.how.b_cta') },
      secondary: { href: `/${locale}/help/build-static`, label: t('ui.how.b_guide') },
    },
  ];
  return (
    <>
      <section className="container stack" aria-labelledby="how-chooser-title">
        <h2 id="how-chooser-title" style={{ margin: 0 }}>{t('ui.how.chooser_title')}</h2>
        <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
          {paths.map((path) => (
            <article className="card stack" key={path.key}>
              <h3 style={{ margin: 0 }}>{path.title}</h3>
              <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                {path.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <div className="row">
                <Link className="button" href={path.cta.href}>{path.cta.label}</Link>
                {path.secondary ? <Link className="button button--secondary" href={path.secondary.href}>{path.secondary.label}</Link> : null}
              </div>
            </article>
          ))}
        </div>
        <p style={{ margin: 0 }}><Link href={`/${locale}/plans/compare`}>{t('ui.how.plans_link')}</Link></p>
      </section>
      <ContentPageView slug="how-it-works" locale={locale} />
    </>
  );
}
