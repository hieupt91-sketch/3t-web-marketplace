
const API_INTERNAL = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

export interface TemplateSummary {
  id: string;
  slug: string;
  locale: string;
  requested_locale: string;
  resolved_locale: string;
  translation_status: 'published' | 'fallback';
  title: string;
  summary: string | null;
  preview_image: string | null;
  modes: string[];
  content_locales: string[];
  capabilities: string[];
  starting_prices: { amount_minor: string; currency: string }[];
}

export type PublicResult<T> = { ok: true; data: T; page?: { next_cursor: string | null; has_more: boolean } } | { ok: false; status: number; requestId: string | null };

/** Public, unauthenticated reads from server components (no cookies forwarded). */
export async function fetchPublic<T>(path: string, locale: string): Promise<PublicResult<T>> {
  const separator = path.includes('?') ? '&' : '?';
  try {
    const res = await fetch(`${API_INTERNAL}/api/v1${path}${separator}locale=${locale}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    const json = (await res.json().catch(() => null)) as { data?: T; page?: { next_cursor: string | null; has_more: boolean }; error?: { request_id?: string } } | null;
    if (!res.ok || !json || json.data === undefined) return { ok: false, status: res.status, requestId: json?.error?.request_id ?? null };
    return { ok: true, data: json.data, page: json.page };
  } catch {
    return { ok: false, status: 503, requestId: null };
  }
}
