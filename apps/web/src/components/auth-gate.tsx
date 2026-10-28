'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMe, type Me } from '@/lib/use-me';
import { ErrorState, Loading } from './ui';
import { SiteHeader } from './site-header';

/** Wraps a page that requires any signed-in (optionally verified) user; redirects to login otherwise. */
export function AuthGate({ children, requireVerified }: { children: (me: Me) => ReactNode; requireVerified?: boolean }) {
  const state = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  useEffect(() => {
    if (state.status === 'anonymous') {
      const next = encodeURIComponent(pathname + window.location.search);
      router.replace(`/auth/login?next=${next}${state.expired ? '&reason=expired' : ''}`);
    }
  }, [state, pathname, router]);

  let body: ReactNode;
  if (state.status === 'loading' || state.status === 'anonymous') body = <Loading />;
  else if (state.status === 'error') body = <ErrorState error={state.error} />;
  else body = <main id="main" className="container container--form" tabIndex={-1}>{children(state.me)}</main>;
  return <><SiteHeader />{body}</>;
}
