import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.home.meta_title'),
    alternates: { canonical: `/${locale}`, languages: { vi: '/vi', en: '/en', 'x-default': '/vi' } },
  };
}

/** P01 — home. Shows only published templates from the API; no placeholder products. */
export default async function Home({ params }: Params) {
  const { locale } = await params;
  const t = (key: string) => translate(locale, key);
  const featured = await fetchPublic<TemplateSummary[]>('/templates?limit=6', locale);
  return (
    <>
      <section className="hero">
        <div className="container stack">
          <h1>{t('ui.home.title')}</h1>
          <p className="muted" style={{ maxWidth: 680 }}>{t('ui.home.lead')}</p>
          <form className="search" action={`/${locale}/templates`} method="get" role="search">
            <label htmlFor="home-search" className="visually-hidden">{t('ui.catalog.search_label')}</label>
            <input id="home-search" className="input" type="search" name="q" placeholder={t('ui.catalog.search_placeholder')} />
            <button className="button" type="submit">{t('ui.catalog.search_action')}</button>
          </form>
        </div>
      </section>
      <div className="container stack">
        <h2>{t('ui.home.featured')}</h2>
        {!featured.ok ? (
          <div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div>
        ) : featured.data.length === 0 ? (
          <div className="card"><p style={{ margin: 0 }}>{t('ui.catalog.empty_catalog')}</p></div>
        ) : (
          <div className="grid-cards">
            {featured.data.map((template) => <TemplateCard key={template.id} template={template} locale={locale} />)}
          </div>
        )}
        <h2>{t('ui.home.modes_title')}</h2>
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
            <h3 style={{ margin: 0 }}>{t('ui.home.status_title')}</h3>
            <p className="muted" style={{ margin: 0 }}>{t('ui.home.status_body')}</p>
            <Link href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>
          </section>
        </div>
      </div>
    </>
  );
}
