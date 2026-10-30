'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * An auto-scrolling showcase row for one homepage category. The track holds
 * two identical groups and translates -50% for a seamless loop; it pauses
 * on hover/focus and while the section is off-screen, and CSS turns it
 * into a plain swipeable row for reduced-motion users. Children (the two
 * groups) are server-rendered template cards.
 */
export function CategoryMarquee({
  children,
  reverse = false,
  durationSeconds,
}: {
  children: ReactNode;
  reverse?: boolean;
  durationSeconds: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) el.dataset.offscreen = entry.isIntersecting ? 'false' : 'true';
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`marquee${reverse ? ' marquee--reverse' : ''}`}>
      <div className="marquee__track" style={{ animationDuration: `${durationSeconds}s` }}>
        {children}
      </div>
    </div>
  );
}
