import type { MetadataRoute } from 'next';

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

/** Private areas are disallowed; robots is not a substitute for auth (docs/07 §7). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/admin', '/account', '/auth', '/checkout', '/demo', '/api'] },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
