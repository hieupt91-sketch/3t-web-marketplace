'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from './api';

export interface Me {
  id: string;
  email: string;
  display_name: string;
  verified: boolean;
  locale: 'vi' | 'en';
  timezone: string;
  roles: string[];
  permissions: string[];
}

export type MeState =
  | { status: 'loading' }
  | { status: 'anonymous'; expired: boolean }
  | { status: 'error'; error: ApiError }
  | { status: 'signed_in'; me: Me; etag: string | null };

export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    api<Me>('/me', { signal: controller.signal })
      .then((res) => {
        if (res.ok) setState({ status: 'signed_in', me: res.data, etag: res.etag });
        else if (res.status === 401) setState({ status: 'anonymous', expired: res.error.code === 'auth.session_expired' });
        else setState({ status: 'error', error: res.error });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return state;
}
