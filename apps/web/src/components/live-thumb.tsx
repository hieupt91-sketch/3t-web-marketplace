'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A live miniature of a template's public demo: the real page rendered in an
 * iframe at desktop width (1280px) and scaled down to fill its frame, so a
 * card shows the actual website instead of a flat picture. The poster image
 * underneath stays visible until the frame has loaded, and the frame only
 * mounts once the card approaches the viewport, so long grids stay cheap.
 * Pointer events are off: the frame is a picture, the card's own links work.
 */
export function LiveThumb({ url, title }: { url: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [active, setActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / 1280);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setActive(true);
          io.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);
  return (
    <div ref={ref} aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {active && scale > 0 ? (
        <iframe
          src={url}
          title={title}
          tabIndex={-1}
          scrolling="no"
          // Same containment as the demo viewer (audit UI-MED-03): the
          // thumbnail renders untrusted template code, so it gets script
          // ability only — no same-origin access, no forms/navigation —
          // and no referrer leaks to the preview origin.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          style={{
            width: 1280,
            height: 800,
            border: 0,
            display: 'block',
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 300ms ease',
          }}
        />
      ) : null}
    </div>
  );
}
