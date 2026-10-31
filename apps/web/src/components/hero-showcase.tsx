'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';

export interface HeroSlide {
  src: string;
  alt: string;
  href?: string;
}

/**
 * The hero banner: a browser window (chrome bar with address pill and
 * live-demo chip) around rotating cover photos — and NOTHING over the
 * photo itself. It is a banner, not a caption card: the dots and the
 * "view this template" link live in a quiet row under the frame.
 * Rotation pauses on hover and for reduced-motion users.
 */
export function HeroShowcase({ slides }: { slides: HeroSlide[] }) {
  const { t } = useT();
  const [active, setActive] = useState(0);
  const paused = useRef(false);
  useEffect(() => {
    if (slides.length < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      if (!paused.current) setActive((i) => (i + 1) % slides.length);
    }, 4500);
    return () => clearInterval(id);
  }, [slides.length]);
  const current = slides[active] ?? slides[0];
  return (
    <div className="hero-visual">
      <div className="hero-blob hero-blob--a" />
      <div className="hero-blob hero-blob--b" />
      <div
        className="browser-frame"
        onMouseEnter={() => {
          paused.current = true;
        }}
        onMouseLeave={() => {
          paused.current = false;
        }}
      >
        <div className="browser-frame__bar">
          <span className="browser-frame__dots" aria-hidden="true">
            <span /><span /><span />
          </span>
          <span className="browser-frame__url">demo.webmaket.com</span>
          <span className="live-chip">
            <span className="live-chip__dot" aria-hidden="true" />
            {t('ui.home.live_demo')}
          </span>
        </div>
        <div className="browser-frame__screen">
          {slides.map((slide, i) => (
            <img
              key={slide.src}
              src={slide.src}
              alt={i === active ? slide.alt : ''}
              loading={i === 0 ? 'eager' : 'lazy'}
              className={`hero-slide${i === active ? ' hero-slide--active' : ''}`}
            />
          ))}
        </div>
      </div>
      {current ? (
        <div className="hero-frame-meta">
          {slides.length > 1 ? (
            <span className="hero-dots">
              {slides.map((slide, i) => (
                <button
                  key={slide.src}
                  type="button"
                  aria-label={slide.alt}
                  aria-current={i === active}
                  className={`hero-dot${i === active ? ' hero-dot--active' : ''}`}
                  onClick={() => setActive(i)}
                />
              ))}
            </span>
          ) : (
            <span />
          )}
          {current.href ? (
            <Link className="hero-frame-meta__link" href={current.href}>
              {t('ui.home.view_template')}
              <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
              </svg>
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
