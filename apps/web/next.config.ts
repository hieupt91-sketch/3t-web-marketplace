import type { NextConfig } from 'next';

const apiInternal = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@3t/i18n'],
  // Same-origin API in development; production routes /api to the API at the reverse proxy.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternal}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // HSTS (audit UI-MED-02 / infra M2): one year + subdomains.
          // No `preload` — joining the browser preload list is an owner
          // decision, not a deploy default.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // CSP (audit UI-MED-01): the portal previously shipped none.
          // script-src keeps 'unsafe-inline' because the App Router
          // streams inline RSC bootstrap scripts (nonce support needs a
          // per-request middleware and is a separate step); everything
          // else is locked to 'self' plus the origins the product itself
          // needs: https images (template previews live on the object
          // store / preview hosts), data:/blob: (QR codes, upload
          // previews), and https frames (live demo/site previews run on
          // subdomains and buyer custom domains).
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https: wss:",
              "frame-src 'self' https:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
      {
        // Private areas are never indexed (docs/07 §7); robots is not a substitute for auth.
        source: '/:area(admin|account|auth|checkout|demo)/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default config;
