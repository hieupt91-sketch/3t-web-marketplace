'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';

const WIDTHS = [
  ['100%', 'ui.import.detail.width_desktop'],
  ['768px', 'ui.import.detail.width_tablet'],
  ['390px', 'ui.import.detail.width_mobile'],
] as const;

/** D01 — public demo viewer. Static demos run on the separate preview origin, sandboxed.
 *  With a template slug it also shows the marketplace bar other demo sites have:
 *  template title, back to detail, and choose-plan — so a visitor can go from
 *  watching the demo straight to buying without hunting for the link. */
export function DemoViewer({ url, title, slug }: { url: string; title: string; slug?: string }) {
  const { t, locale } = useT();
  const [width, setWidth] = useState<(typeof WIDTHS)[number][0]>('100%');
  return (
    <div className="stack">
      {slug ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{title}</strong>
          <div className="row">
            <a className="button button--secondary" href={`/${locale}/templates/${slug}`}>{t('ui.catalog.view_detail')}</a>
            <a className="button" href={`/checkout/configure?template=${slug}`}>{t('ui.detail.choose_plan')}</a>
          </div>
        </div>
      ) : null}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div role="group" aria-label={t('ui.import.detail.preview_width')} className="row">
          {WIDTHS.map(([value, key]) => (
            <button key={value} type="button" className={`button ${width === value ? '' : 'button--secondary'}`} aria-pressed={width === value} onClick={() => setWidth(value)}>
              {t(key)}
            </button>
          ))}
        </div>
        <a className="button button--secondary" href={url} target="_blank" rel="noopener noreferrer nofollow">{t('ui.import.detail.open_preview')}</a>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t('ui.demo.simulated_note')}</p>
      {/* Separate origin + sandbox without allow-same-origin: demo code cannot read portal cookies. */}
      <iframe
        className="preview-frame"
        style={{ maxWidth: width, height: 640 }}
        src={url}
        title={t('ui.demo.frame_title', { title })}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}
