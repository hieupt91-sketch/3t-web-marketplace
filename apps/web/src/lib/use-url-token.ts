'use client';

import { useEffect, useState } from 'react';

/**
 * Read a one-time token from the URL once, then remove it from the address bar and history so it
 * does not linger in screenshots, history sync or Referer headers (docs/03 §7).
 */
export function useUrlToken(): { token: string | null; ready: boolean } {
  const [state, setState] = useState<{ token: string | null; ready: boolean }>({ token: null, ready: false });
  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) {
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
    setState({ token, ready: true });
  }, []);
  return state;
}
