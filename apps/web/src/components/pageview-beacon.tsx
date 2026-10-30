'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * First-party statistics beacon: one lightweight POST per storefront
 * page view (home, catalog, template details, plans, help). The server
 * stores only the path and a daily-rotating visitor hash — no cookies,
 * no raw IPs — and drops bot user-agents. Fire-and-forget: a failed
 * beacon must never affect the page.
 */
export function PageViewBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    const rel = pathname.replace(/^\/(vi|en)(?=\/|$)/, '') || '/';
    const tracked = rel === '/' || /^\/(templates|plans|how-it-works|help)(\/|$)/.test(rel);
    if (!tracked) return;
    void fetch('/api/v1/analytics/pageview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rel }),
      keepalive: true,
    }).catch(() => {});
  }, [pathname]);
  return null;
}
