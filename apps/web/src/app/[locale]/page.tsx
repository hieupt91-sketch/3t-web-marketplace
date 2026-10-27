import type { Metadata } from 'next';
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

/** One clear level of categories (docs/10); each card links to the filtered catalog. */
const CATEGORIES = [
  { code: 'landing', desc: 'ui.home.cat_landing' },
  { code: 'business', desc: 'ui.home.cat_business' },
  { code: 'food', desc: 'ui.home.cat_food' },
  { code: 'realestate', desc: 'ui.home.cat_realestate' },
  { code: 'store', desc: 'ui.home.cat_store' },
  { code: 'beauty', desc: 'ui.home.cat_beauty' },
  { code: 'blog', desc: 'ui.home.cat_blog' },
  { code: 'portfolio', desc: 'ui.home.cat_portfolio' },
] as const;

/** P01 — home. Shows only published templates from the API; no placeholder products. */
export default async function Home({ params }: Params) {
  const { locale } = await params;
  const t = (key: string) => translate(locale, key);
  const featured = await fetchPublic<TemplateSummary[]>('/templates?limit=6', locale);
  return (
    <>
      <section className="hero">
        <div className="container stack">
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
            <li>{t('ui.home.trust_demo')}</li>
            <li>{t('ui.home.trust_instant')}</li>
            <li>{t('ui.home.trust_support')}</li>
          </ul>
        </div>
      </section>
      <div className="container stack">
        <section className="stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.categories_title')}</h2>
          <p className="muted" style={{ margin: 0 }}>{t('ui.home.categories_lead')}</p>
          <div className="grid-cards">
            {CATEGORIES.map((category) => (
              <Link key={category.code} className="card category-card" href={`/${locale}/templates?category=${category.code}`}>
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
