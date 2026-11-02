'use client';

/**
 * Same-origin API client. Cookies travel automatically; the browser adds Origin for mutations,
 * which the API checks (CSRF). Money and IDs stay strings exactly as the API returns them.
 */
export interface ApiError {
  code: string;
  message: string;
  field_errors: { field: string; code: string }[];
  request_id: string | null;
  retryable: boolean;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T; etag: string | null; raw: unknown }
  | { ok: false; status: number; error: ApiError };

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string | null;
  signal?: AbortSignal;
}

const NETWORK_ERROR: ApiError = { code: 'network.unavailable', message: '', field_errors: [], request_id: null, retryable: true };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.ifMatch) headers['if-match'] = options.ifMatch;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return { ok: false, status: 0, error: NETWORK_ERROR };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T, etag: null, raw: null };
  const json = (await res.json().catch(() => null)) as { data?: T; error?: ApiError } | null;
  if (!res.ok || !json || json.error) {
    return {
      ok: false,
      status: res.status,
      error: json?.error ?? { ...NETWORK_ERROR, code: 'internal.error', retryable: res.status >= 500 },
    };
  }
  return { ok: true, status: res.status, data: json.data as T, etag: res.headers.get('etag'), raw: json };
}

/** Upload raw bytes with real progress (XHR exposes upload progress; fetch does not). */
export function uploadWithProgress(url: string, file: Blob, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal) {
  return new Promise<{ status: number; body: { data?: unknown; error?: ApiError } | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/zip');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/** Internal return paths only (docs/05 §4): no scheme, no protocol-relative, no backslashes. */
export function safeReturnPath(value: string | null | undefined, fallback = '/account'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\0')) return fallback;
  if (value.startsWith('/auth/')) return fallback;
  return value;
}
