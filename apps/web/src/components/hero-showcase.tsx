'use client';

import { useEffect, useRef, useState } from 'react';

export interface HeroSlide {
  src: string;
  alt: string;
}

/** A small crossfading image stack used by the hero's floating cards. */
function SlideStack({ slides, intervalMs }: { slides: HeroSlide[]; intervalMs: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (slides.length < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % slides.length), intervalMs);
    return () => clearInterval(id);
  }, [slides.length, intervalMs]);
  return (
    <>
      {slides.map((slide, i) => (
        <img
          key={slide.src}
          src={slide.src}
          alt=""
          loading="lazy"
          className={`float-slide${i === index ? ' float-slide--active' : ''}`}
        />
      ))}
    </>
  );
}

/**
 * The hero visual as a living showcase (owner request): the main frame
 * crossfades through real template cover photos with a slow Ken Burns
 * drift and dot navigation, and the two floating cards cycle their own
 * photos on offset timers. Everything pauses on hover of the frame and
 * stays still for reduced-motion users.
 */
export function HeroShowcase({ slides, floatA, floatB }: { slides: HeroSlide[]; floatA: HeroSlide[]; floatB: HeroSlide[] }) {
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
  return (
    <div className="hero-visual">
      <div className="hero-blob hero-blob--a" />
      <div className="hero-blob hero-blob--b" />
      <div
        className="hero-frame"
        onMouseEnter={() => {
          paused.current = true;
        }}
        onMouseLeave={() => {
          paused.current = false;
        }}
      >
        {slides.map((slide, i) => (
          <img
            key={slide.src}
            src={slide.src}
            alt={i === active ? slide.alt : ''}
            loading={i === 0 ? 'eager' : 'lazy'}
            className={`hero-slide${i === active ? ' hero-slide--active' : ''}`}
          />
        ))}
        {slides.length > 1 ? (
          <div className="hero-dots">
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
          </div>
        ) : null}
      </div>
      <div className="float-card float-card--a">
        <SlideStack slides={floatA} intervalMs={6000} />
      </div>
      <div className="float-card float-card--b">
        <SlideStack slides={floatB} intervalMs={7200} />
      </div>
    </div>
  );
}
