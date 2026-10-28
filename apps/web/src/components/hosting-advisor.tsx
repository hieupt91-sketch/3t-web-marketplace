'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';

type SiteType = 'landing' | 'news' | 'product';
type Domain = 'own' | 'free';
type Images = 'few' | 'many';
type Frequency = 'rare' | 'often';
type Admin = 'none' | 'content' | 'orders';
type Rec = 'pages' | 'r2' | 'cms' | 'dynamic' | 'runtime';

function RadioRow<T extends string>({ name, value, options, onChange }: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="row" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className="row" style={{ gap: '0.25rem' }}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Needs-based hosting advisor on the template detail page.
 * Advice is grounded in this template's own facts (static vs runtime
 * adapter, package size) plus the verified free-tier limits for static
 * hosting (Pages: unlimited bandwidth, 20,000 files, 500 builds/month;
 * R2: 10 GB free, zero egress fees).
 *
 * Admin is a first-class need, not a dead end, because news and product
 * sites all need one:
 *  - content admin (posting articles/products) on a static template is
 *    served by a Git-based CMS: content becomes files, each save redeploys;
 *  - orders/payments need a real server + database, which no static
 *    template (even with a CMS) provides — that is a custom project.
 * Posting frequency matters because every save is one deploy against the
 * 500/month free build limit.
 * The advisor never promises platform subdomain hosting or a built-in
 * admin panel the template does not have.
 */
export function HostingAdvisor({ adapter, sizeLabel }: { adapter: string | null; sizeLabel: string | null }) {
  const { t } = useT();
  const [siteType, setSiteType] = useState<SiteType>('landing');
  const [domain, setDomain] = useState<Domain>('own');
  const [images, setImages] = useState<Images>('few');
  const [frequency, setFrequency] = useState<Frequency>('often');
  const [admin, setAdmin] = useState<Admin>('content');

  const isRuntime = adapter === 'node-http' || adapter === 'next-standalone';
  const rec: Rec = isRuntime
    ? 'runtime'
    : admin === 'orders' ? 'dynamic'
    : admin === 'content' ? 'cms'
    : images === 'many' ? 'r2' : 'pages';
  const countsDeploys = rec === 'pages' || rec === 'r2' || rec === 'cms';
  // Explicit literal keys (not dynamic template strings) so the
  // check-ui-strings gate verifies every recommendation key exists.
  const recs: Record<Rec, { title: string; body: string; steps: string[] }> = {
    pages: { title: t('ui.advisor.rec_pages_title'), body: t('ui.advisor.rec_pages_body'), steps: [t('ui.advisor.rec_pages_step1'), t('ui.advisor.rec_pages_step2'), t('ui.advisor.rec_pages_step3')] },
    r2: { title: t('ui.advisor.rec_r2_title'), body: t('ui.advisor.rec_r2_body'), steps: [t('ui.advisor.rec_r2_step1'), t('ui.advisor.rec_r2_step2'), t('ui.advisor.rec_r2_step3')] },
    cms: { title: t('ui.advisor.rec_cms_title'), body: t('ui.advisor.rec_cms_body'), steps: [t('ui.advisor.rec_cms_step1'), t('ui.advisor.rec_cms_step2'), t('ui.advisor.rec_cms_step3')] },
    dynamic: { title: t('ui.advisor.rec_dynamic_title'), body: t('ui.advisor.rec_dynamic_body'), steps: [] },
    runtime: { title: t('ui.advisor.rec_runtime_title'), body: t('ui.advisor.rec_runtime_body'), steps: [t('ui.advisor.rec_runtime_step1'), t('ui.advisor.rec_runtime_step2'), t('ui.advisor.rec_runtime_step3')] },
  };
  const recText = recs[rec];

  return (
    <div className="stack">
      <h2 style={{ marginTop: 0 }}>{t('ui.advisor.title')}</h2>
      <p style={{ margin: 0 }}>{t('ui.advisor.intro')}</p>
      <p style={{ margin: 0 }} className="muted">
        {isRuntime ? t('ui.advisor.template_runtime') : t('ui.advisor.template_static')}
        {sizeLabel ? ` ${t('ui.advisor.template_size', { size: sizeLabel })}` : ''}
      </p>
      <fieldset className="stack">
        <legend>{t('ui.advisor.q_type')}</legend>
        <RadioRow name="advisor-type" value={siteType} onChange={setSiteType} options={[
          { value: 'landing', label: t('ui.advisor.q_type_landing') },
          { value: 'news', label: t('ui.advisor.q_type_news') },
          { value: 'product', label: t('ui.advisor.q_type_product') },
        ]} />
      </fieldset>
      <fieldset className="stack">
        <legend>{t('ui.advisor.q_domain')}</legend>
        <RadioRow name="advisor-domain" value={domain} onChange={setDomain} options={[
          { value: 'own', label: t('ui.advisor.q_domain_own') },
          { value: 'free', label: t('ui.advisor.q_domain_free') },
        ]} />
      </fieldset>
      <fieldset className="stack">
        <legend>{t('ui.advisor.q_images')}</legend>
        <RadioRow name="advisor-images" value={images} onChange={setImages} options={[
          { value: 'few', label: t('ui.advisor.q_images_few') },
          { value: 'many', label: t('ui.advisor.q_images_many') },
        ]} />
      </fieldset>
      <fieldset className="stack">
        <legend>{t('ui.advisor.q_freq')}</legend>
        <RadioRow name="advisor-freq" value={frequency} onChange={setFrequency} options={[
          { value: 'rare', label: t('ui.advisor.q_freq_rare') },
          { value: 'often', label: t('ui.advisor.q_freq_often') },
        ]} />
      </fieldset>
      <fieldset className="stack">
        <legend>{t('ui.advisor.q_admin')}</legend>
        <RadioRow name="advisor-admin" value={admin} onChange={setAdmin} options={[
          { value: 'none', label: t('ui.advisor.q_admin_none') },
          { value: 'content', label: t('ui.advisor.q_admin_content') },
          { value: 'orders', label: t('ui.advisor.q_admin_orders') },
        ]} />
      </fieldset>
      <div className="card stack">
        <h3 style={{ marginTop: 0 }}>{recText.title}</h3>
        <p style={{ margin: 0 }}>{recText.body}</p>
        {recText.steps.length > 0 ? (
          <ol style={{ margin: 0 }}>
            {recText.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        ) : null}
        {rec === 'pages' && siteType === 'news' ? <p style={{ margin: 0 }}>{t('ui.advisor.rec_news_note')}</p> : null}
        {rec === 'cms' && images === 'many' ? <p style={{ margin: 0 }}>{t('ui.advisor.cms_images_note')}</p> : null}
        {countsDeploys && frequency === 'often' ? <p style={{ margin: 0 }}>{t('ui.advisor.freq_note')}</p> : null}
        <p style={{ margin: 0 }}>{domain === 'own' ? t('ui.advisor.domain_own_note') : t('ui.advisor.domain_free_note')}</p>
        <p style={{ margin: 0 }} className="muted">{t('ui.advisor.paid_note')}</p>
      </div>
    </div>
  );
}
