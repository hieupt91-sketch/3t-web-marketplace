import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';
import { TemplateFinder } from '@/components/template-finder';
import { DemoCatalog } from '@/components/demo-catalog';

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.home.meta_title'),
    alternates: { canonical: `/${locale}`, languages: { vi: '/vi', en: '/en', 'x-default': '/vi' } },
  };
}

/** Small stroke icons for the hero trust points (Canva v6: eye, bolt, headset). */
function TrustIcon({ kind }: { kind: 'eye' | 'bolt' | 'headset' }) {
  if (kind === 'bolt') {
    return (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>);
  }
  if (kind === 'headset') {
    return (<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="3" y="14" width="4" height="6" rx="2" /><rect x="17" y="14" width="4" height="6" rx="2" /></svg>);
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>);
}

/** P01 — home. Shows only published templates from the API; no placeholder products. */
export default async function Home({ params }: Params) {
  const { locale } = await params;
  const t = (key: string) => translate(locale, key);
  const featured = await fetchPublic<TemplateSummary[]>('/templates?limit=6', locale);
  return (
    <>
      <section className="hero">
        <div className="container hero-layout">
          <div className="stack">
            <p className="hero-badge">{t('ui.home.badge')}</p>
            <h1>{t('ui.home.title')}</h1>
            <p className="muted" style={{ maxWidth: 680 }}>{t('ui.home.lead')}</p>
            <form className="search" action={`/${locale}/templates`} method="get" role="search">
              <label htmlFor="home-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
              <input id="home-search" className="input" type="search" name="q" placeholder={t('ui.catalog.search_placeholder')} />
              <button className="button" type="submit">{t('ui.catalog.search_action')}</button>
            </form>
            <div className="hero-actions">
              <Link className="button" href={`/${locale}/templates`}>{t('ui.home.browse_all')}</Link>
              <Link className="button button--secondary" href={`/${locale}/how-it-works`}>{t('ui.home.how_it_works')}</Link>
            </div>
            <ul className="trust-row">
              <li><span className="trust-icon"><TrustIcon kind="eye" /></span>{t('ui.home.trust_demo')}</li>
              <li><span className="trust-icon"><TrustIcon kind="bolt" /></span>{t('ui.home.trust_instant')}</li>
              <li><span className="trust-icon"><TrustIcon kind="headset" /></span>{t('ui.home.trust_support')}</li>
            </ul>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="hero-blob hero-blob--a" />
            <div className="hero-blob hero-blob--b" />
            <div className="hero-frame">
              <img src="/hero/hero-showcase.jpg" alt="" width={960} height={640} />
            </div>
            <div className="float-card float-card--a">
              <img src="/demo/demo-fashion.jpg" alt="" width={300} height={200} />
            </div>
            <div className="float-card float-card--b">
              <img src="/demo/demo-restaurant.jpg" alt="" width={300} height={200} />
            </div>
          </div>
        </div>
      </section>
      <div className="container stack">
        <TemplateFinder />
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.featured')}</h2>
          {!featured.ok ? (
            <div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div>
          ) : featured.data.length === 0 ? (
            <>
              <div className="card"><p style={{ margin: 0 }}>{t('ui.catalog.empty_catalog')}</p></div>
              <DemoCatalog locale={locale} />
            </>
          ) : (
            <div className="grid-cards">
              {featured.data.map((template) => <TemplateCard key={template.id} template={template} locale={locale} />)}
            </div>
          )}
        </section>
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.help_row_title')}</h2>
          <p className="muted" style={{ margin: 0 }}>
            <Link href={`/${locale}/help/help-find-template`}>{t('ui.home.help_find')}</Link>{' · '}
            <Link href={`/${locale}/help/help-buy`}>{t('ui.home.help_buy')}</Link>{' · '}
            <Link href={`/${locale}/help/help-after-buy`}>{t('ui.home.help_after')}</Link>{' · '}
            <Link href={`/${locale}/help/help-build-static`}>{t('ui.home.guide_static_title')}</Link>{' · '}
            <Link href={`/${locale}/help/help-build-dynamic`}>{t('ui.home.guide_dynamic_title')}</Link>{' · '}
            <Link href={`/${locale}/help/help-account`}>{t('ui.home.help_account')}</Link>{' · '}
            <Link href={`/${locale}/help/help-partner`}>{t('ui.home.help_partner')}</Link>{' · '}
            <Link href={`/${locale}/help`}>{t('ui.home.help_all')}</Link>
          </p>
        </section>
        <section className="cta-band stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.cta_title')}</h2>
          <p style={{ margin: 0 }}>{t('ui.home.cta_body')}</p>
          <div><Link className="button" href={`/${locale}/contact`}>{t('ui.home.cta_action')}</Link></div>
        </section>
      </div>
    </>
  );
}
