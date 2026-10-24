import { fetchPublic } from './api-server';

export interface ContentPage {
  slug: string;
  kind: string;
  title: string | null;
  body: string | null;
  requested_locale: string;
  resolved_locale: string;
  translation_status: 'published' | 'fallback' | 'missing';
}

export interface PolicyDoc {
  code: string;
  version: string;
  effective_at: string | null;
  title: string | null;
  body: string | null;
  resolved_locale: string;
  translation_status: 'published' | 'fallback' | 'missing';
}

export const fetchPage = (slug: string, locale: string) => fetchPublic<ContentPage>(`/pages/public/${encodeURIComponent(slug)}`, locale);
export const fetchHelpIndex = (locale: string) => fetchPublic<{ slug: string; title: string }[]>(`/pages/help`, locale);
export const fetchPolicy = (code: string, locale: string) => fetchPublic<PolicyDoc>(`/policies/${encodeURIComponent(code)}`, locale);
