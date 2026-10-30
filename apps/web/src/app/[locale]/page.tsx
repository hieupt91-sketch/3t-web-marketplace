import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { fetchPublic, type TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';
import { TemplateFinder } from '@/components/template-finder';
import { DemoCatalog } from '@/components/demo-catalog';
import { CategoryMarquee } from '@/components/category-marquee';
import { HeroShowcase, type HeroSlide } from '@/components/hero-showcase';

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
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  const catalog = await fetchPublic<TemplateSummary[]>('/templates?limit=100', locale);
  // The storefront groups templates by category (owner request): one section
  // per category with a link into the filtered library.
  const CATEGORY_ORDER = ['food', 'beauty', 'realestate', 'business', 'store', 'landing', 'portfolio', 'blog', 'website'];
  const byCategory = new Map<string, TemplateSummary[]>();
  if (catalog.ok) {
    for (const tpl of catalog.data) {
      const code = tpl.category ?? 'website';
      const list = byCategory.get(code) ?? [];
      list.push(tpl);
      byCategory.set(code, list);
    }
  }
  const categoryCodes = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];
  // Hero showcase: real cover photos, one per category first, rotating in
  // the frame; the floating cards cycle the next picks. Static artwork is
  // the fallback when the catalog cannot be read.
  const photoPool = catalog.ok ? catalog.data.filter((x) => x.preview_image) : [];
  const distinctSlides: HeroSlide[] = [];
  {
    const seen = new Set<string>();
    for (const x of photoPool) {
      const code = x.category ?? 'website';
      if (seen.has(code)) continue;
      seen.add(code);
      distinctSlides.push({ src: x.preview_image!, alt: x.title });
    }
  }
  const heroSlides = distinctSlides.slice(0, 5);
  const heroFloatA = distinctSlides.slice(5, 8);
  const heroFloatB = distinctSlides.length > 8 ? distinctSlides.slice(8, 11) : distinctSlides.slice(1, 4);
  const heroFallback: HeroSlide[] = [{ src: '/hero/hero-showcase.jpg', alt: '' }];
  const floatFallbackA: HeroSlide[] = [{ src: '/demo/demo-fashion.jpg', alt: '' }];
  const floatFallbackB: HeroSlide[] = [{ src: '/demo/demo-restaurant.jpg', alt: '' }];
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
            <p style={{ margin: 0 }}><Link href={`/${locale}/plans/compare`}>{t('ui.home.compare_plans')}</Link></p>
            <ul className="trust-row">
              <li><span className="trust-icon"><TrustIcon kind="eye" /></span>{t('ui.home.trust_demo')}</li>
              <li><span className="trust-icon"><TrustIcon kind="bolt" /></span>{t('ui.home.trust_instant')}</li>
              <li><span className="trust-icon"><TrustIcon kind="headset" /></span>{t('ui.home.trust_support')}</li>
            </ul>
          </div>
          <HeroShowcase
            slides={heroSlides.length > 0 ? heroSlides : heroFallback}
            floatA={heroFloatA.length > 0 ? heroFloatA : floatFallbackA}
            floatB={heroFloatB.length > 0 ? heroFloatB : floatFallbackB}
          />
        </div>
      </section>
      <div className="container stack">
        <TemplateFinder />
        {catalog.ok && catalog.data.length > 0 ? (
          <nav className="cat-nav" aria-label={t('ui.home.purpose_title')}>
            {categoryCodes.map((code) => {
              const label = t(`ui.category.${code}`);
              return (
                <a className="cat-chip" key={code} href={`#cat-${code}`}>
                  {label === `ui.category.${code}` ? code : label}
                  <span className="cat-chip__count">{byCategory.get(code)!.length}</span>
                </a>
              );
            })}
          </nav>
        ) : null}
        {!catalog.ok ? (
          <section className="stack">
            <div className="alert alert--error" role="alert"><p>{t('ui.catalog.unavailable')}</p></div>
          </section>
        ) : catalog.data.length === 0 ? (
          <section className="stack">
            <div className="card"><p style={{ margin: 0 }}>{t('ui.catalog.empty_catalog')}</p></div>
            <DemoCatalog locale={locale} />
          </section>
        ) : (
          categoryCodes.map((code, sectionIndex) => {
            const label = t(`ui.category.${code}`);
            const items = byCategory.get(code)!;
            const shown = items.slice(0, 8);
            const cards = (list: TemplateSummary[]) => list.map((template) => <TemplateCard key={template.id} template={template} locale={locale} />);
            return (
              <section className="stack cat-section" id={`cat-${code}`} key={code}>
                <div className="row cat-section__head">
                  <h2 style={{ margin: 0 }}>{label === `ui.category.${code}` ? code : label}</h2>
                  <span className="badge">{t('ui.home.template_count', { count: String(items.length) })}</span>
                  <span className="cat-section__spacer" />
                  <Link href={`/${locale}/templates?category=${code}`}>{t('ui.home.view_all')}</Link>
                </div>
                {shown.length >= 2 ? (
                  <CategoryMarquee reverse={sectionIndex % 2 === 1} durationSeconds={Math.max(30, shown.length * 7)}>
                    <div className="marquee__group">{cards(shown)}</div>
                    <div className="marquee__group" aria-hidden="true" inert>
                      {cards(shown)}
                    </div>
                  </CategoryMarquee>
                ) : (
                  <div className="grid-cards">{cards(shown)}</div>
                )}
              </section>
            );
          })
        )}
        <section className="cta-band stack">
          <h2 style={{ margin: 0 }}>{t('ui.home.cta_title')}</h2>
          <p style={{ margin: 0 }}>{t('ui.home.cta_body')}</p>
          <div><Link className="button" href={`/${locale}/contact`}>{t('ui.home.cta_action')}</Link></div>
        </section>
      </div>
    </>
  );
}
