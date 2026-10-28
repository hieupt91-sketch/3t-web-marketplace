import { translate, type Locale } from '@3t/i18n';

/** Layout-preview cards shown ONLY when the catalog is empty and no filter is
 *  active. They are not templates: no price, no link, no detail page — and they
 *  disappear automatically once a real template is published. */
const ITEMS = [
  { image: '/demo/demo-fashion.jpg', vi: 'Cửa hàng thời trang', en: 'Fashion store' },
  { image: '/demo/demo-restaurant.jpg', vi: 'Nhà hàng', en: 'Restaurant' },
  { image: '/demo/demo-realestate.jpg', vi: 'Bất động sản', en: 'Real estate' },
  { image: '/demo/demo-saas.jpg', vi: 'Phần mềm SaaS', en: 'SaaS software' },
];

export function DemoCatalog({ locale }: { locale: Locale }) {
  const t = (key: string) => translate(locale, key);
  return (
    <section className="stack" aria-label={t('ui.catalog.demo_title')}>
      <h2 style={{ marginBottom: 0 }}>{t('ui.catalog.demo_title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('ui.catalog.demo_note')}</p>
      <div className="grid-cards">
        {ITEMS.map((item) => (
          <article className="card template-card" key={item.image}>
            <div className="template-card__image">
              <img src={item.image} alt={locale === 'vi' ? item.vi : item.en} />
            </div>
            <h3 style={{ margin: 0 }}>{locale === 'vi' ? item.vi : item.en}</h3>
            <p style={{ margin: 0 }}><span className="badge badge--neutral">{t('ui.catalog.demo_badge')}</span></p>
          </article>
        ))}
      </div>
    </section>
  );
}
