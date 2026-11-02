'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/**
 * Auto-scrolling category shelf that stays fully hand-drivable: it
 * glides on its own (~53px/s, same pace as the earlier CSS version),
 * pauses on hover or while off-screen, can be DRAGGED to scrub through
 * the row quickly, and has prev/next arrow buttons that page two cards
 * at a time. Motion is JS-driven (one rAF loop) so the idle glide, the
 * drag and the arrows all share a single position and wrap seamlessly
 * over the duplicated list. Reduced-motion disables the idle glide;
 * drag and arrows keep working. A drag suppresses the click that would
 * otherwise open a card.
 */
export function CategoryMarquee({ children, reverse = false, durationSeconds }: { children: ReactNode; reverse?: boolean; durationSeconds?: number }) {
  const { t } = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<((direction: 1 | -1) => void) | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const track = trackRef.current;
    if (!wrap || !track) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let half = 0;
    const measure = () => {
      half = track.scrollWidth / 2;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);

    let x = 0;
    let target: number | null = null;
    let hovering = false;
    let dragging = false;
    let visible = true;
    let last = performance.now();
    let raf = 0;
    const speed = 26;
    const dir = reverse ? -1 : 1;
    // Callers pass a full-loop duration (scaled by item count); the pace
    // is derived from the measured half-width so longer rows do not run
    // faster than shorter ones.
    const glideSpeed = () => (durationSeconds && half > 0 ? half / durationSeconds : speed);

    const apply = () => {
      if (half <= 0) return;
      const wrapped = ((x % half) + half) % half;
      track.style.transform = `translateX(${-wrapped}px)`;
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!dragging && half > 0) {
        if (target !== null) {
          const diff = target - x;
          x += Math.abs(diff) < 0.6 ? diff : diff * Math.min(1, dt * 7);
          if (Math.abs(target - x) < 0.6) {
            x = target;
            target = null;
          }
          apply();
        } else if (!reduced && !hovering && visible) {
          x += dir * glideSpeed() * dt;
          apply();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    pageRef.current = (direction) => {
      const card = track.querySelector('.template-card');
      const step = card ? (card.getBoundingClientRect().width + 24) * 2 : 700;
      target = x + direction * step;
    };

    const io = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true; }, { threshold: 0.05 });
    io.observe(wrap);
    const onEnter = () => { hovering = true; };
    const onLeave = () => { hovering = false; };
    wrap.addEventListener('mouseenter', onEnter);
    wrap.addEventListener('mouseleave', onLeave);

    let startX = 0;
    let startPos = 0;
    let moved = 0;
    let pendingDrag = false;
    const onDown = (e: PointerEvent) => {
      // Arm on any press, but do NOT capture yet: capturing on press
      // retargets the following click to the wrap, so card links and
      // the paging buttons would never receive a real mouse click.
      // Capture is deferred until the pointer actually moves (onMove);
      // a press that turns into a drag has its click suppressed by the
      // capture-phase handler below.
      pendingDrag = true;
      moved = 0;
      startX = e.clientX;
      startPos = x;
      target = null;
    };
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      if (pendingDrag && !dragging && Math.abs(dx) > 6) {
        dragging = true;
        wrap.classList.add('marquee--dragging');
        try { wrap.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      }
      if (!dragging) return;
      moved = Math.max(moved, Math.abs(dx));
      x = startPos - dx;
      apply();
    };
    const onUp = (e: PointerEvent) => {
      pendingDrag = false;
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('marquee--dragging');
      try { wrap.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // A real drag is normally followed by a click event, which the
      // capture handler below consumes (and resets `moved`). If the
      // gesture ended without one (pointercancel, capture lost), clear
      // the flag shortly after so the next genuine click is not eaten.
      if (moved > 6) setTimeout(() => { moved = 0; }, 350);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved > 6) {
        e.preventDefault();
        e.stopPropagation();
        moved = 0;
      }
    };
    const onDragStart = (e: Event) => e.preventDefault();
    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerup', onUp);
    wrap.addEventListener('pointercancel', onUp);
    wrap.addEventListener('click', onClickCapture, true);
    wrap.addEventListener('dragstart', onDragStart);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      wrap.removeEventListener('mouseenter', onEnter);
      wrap.removeEventListener('mouseleave', onLeave);
      wrap.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
      wrap.removeEventListener('click', onClickCapture, true);
      wrap.removeEventListener('dragstart', onDragStart);
      pageRef.current = null;
    };
  }, [reverse, durationSeconds]);

  return (
    <div className="marquee-wrap" ref={wrapRef}>
      <div className="marquee">
        <div className="marquee__track" ref={trackRef}>
          <div className="marquee__group">{children}</div>
          <div className="marquee__group" aria-hidden="true" inert>
            {children}
          </div>
        </div>
      </div>
      <button type="button" className="marquee__nav marquee__nav--prev" aria-label={t('ui.common.back')} onClick={() => pageRef.current?.(-1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <button type="button" className="marquee__nav marquee__nav--next" aria-label={t('ui.catalog.more')} onClick={() => pageRef.current?.(1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
