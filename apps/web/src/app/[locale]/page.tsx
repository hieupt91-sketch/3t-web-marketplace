import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';
import { DemoCatalog } from '@/components/demo-catalog';

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.home.meta_title'),
    alternates: { canonical: `/${locale}`, languages: { vi: '/vi', en: '/en', 'x-default': '/vi' } },
  };
}

/** One clear level of categories (docs/10); each card links to the filtered catalog.
 *  a/b are the card illustration gradients (Canva v6); wording stays the site's own. */
const CATEGORIES = [
  { code: 'landing', desc: 'ui.home.cat_landing', a: '#1d4ed8', b: '#7c3aed' },
  { code: 'business', desc: 'ui.home.cat_business', a: '#0f766e', b: '#0ea5e9' },
  { code: 'food', desc: 'ui.home.cat_food', a: '#ea580c', b: '#f43f5e' },
  { code: 'realestate', desc: 'ui.home.cat_realestate', a: '#0284c7', b: '#6366f1' },
  { code: 'store', desc: 'ui.home.cat_store', a: '#db2777', b: '#8b5cf6' },
  { code: 'beauty', desc: 'ui.home.cat_beauty', a: '#06b6d4', b: '#3b82f6' },
  { code: 'blog', desc: 'ui.home.cat_blog', a: '#d97706', b: '#ea580c' },
  { code: 'portfolio', desc: 'ui.home.cat_portfolio', a: '#475569', b: '#8b5cf6' },
] as const;

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
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.intro_title')}</h2>
          <p className="muted" style={{ margin: 0, maxWidth: 760 }}>{t('ui.home.intro_lead')}</p>
          <div className="grid-cards">
            {[1, 2, 3].map((pillar) => (
              <section className="card stack" key={pillar}>
                <h3 style={{ margin: 0 }}>{t(`ui.home.intro_p${pillar}_title`)}</h3>
                <p className="muted" style={{ margin: 0 }}>{t(`ui.home.intro_p${pillar}_body`)}</p>
              </section>
            ))}
          </div>
        </section>
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.categories_title')}</h2>
          <p className="muted" style={{ margin: 0 }}>{t('ui.home.categories_lead')}</p>
          <div className="grid-cards">
            {CATEGORIES.map((category) => (
              <Link key={category.code} className="card category-card" href={`/${locale}/templates?category=${category.code}`}>
                <div className="cat-art" aria-hidden="true" style={{ '--cat-a': category.a, '--cat-b': category.b } as CSSProperties}>
                  <div className="cat-art__dots"><i /><i /><i /></div>
                  <div className="cat-art__hero" />
                  <div className="cat-art__row"><i /><i /><i /></div>
                </div>
                <h3 style={{ margin: 0 }}>{t(`ui.category.${category.code}`)}</h3>
                <p className="muted" style={{ margin: 0 }}>{t(category.desc)}</p>
              </Link>
            ))}
          </div>
        </section>
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
          <h2 style={{ margin: 0 }}>{t('ui.home.steps_title')}</h2>
          <div className="grid-cards">
            {[1, 2, 3].map((step) => (
              <section className="card stack" key={step}>
                <span className="step-number" aria-hidden="true">{step}</span>
                <h3 style={{ margin: 0 }}>{t(`ui.home.step${step}_title`)}</h3>
                <p className="muted" style={{ margin: 0 }}>{t(`ui.home.step${step}_body`)}</p>
              </section>
            ))}
          </div>
        </section>
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.modes_title')}</h2>
          <div className="grid-cards">
            <section className="card stack">
              <h3 style={{ margin: 0 }}>{t('ui.home.mode_selfhost_title')}</h3>
              <p className="muted" style={{ margin: 0 }}>{t('ui.home.mode_selfhost_body')}</p>
            </section>
            <section className="card stack">
              <h3 style={{ margin: 0 }}>{t('ui.home.mode_hosted_title')}</h3>
              <p className="muted" style={{ margin: 0 }}>{t('ui.home.mode_hosted_body')}</p>
            </section>
            <section className="card stack">
              <h3 style={{ margin: 0 }}>{t('ui.home.project_title')}</h3>
              <p className="muted" style={{ margin: 0 }}>{t('ui.home.project_body')}</p>
              <div><Link href={`/${locale}/contact`}>{t('ui.home.project_action')}</Link></div>
            </section>
          </div>
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
