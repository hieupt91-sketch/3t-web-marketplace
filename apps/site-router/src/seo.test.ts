import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Db } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSiteRouterServer } from './server.ts';
import { identityFromHtmlHead, injectSeoJsonLd, type SeoIdentity } from './seo.ts';

const BASE = 'webmaket.local';

/** A small frozen-static homepage in the factory's shape: bilingual
 *  head (data-vi/data-en title, data-desc-* description) and the seed
 *  identity strings visible in the body — what candidate extraction
 *  verifies against. */
const STATIC_HTML = [
  '<!DOCTYPE html>',
  '<html lang="vi">',
  '<head>',
  '<meta charset="utf-8">',
  '<title data-vi="Phụ Tùng Trường Sơn — Phụ tùng ô tô Quận 5" data-en="Truong Son Auto Parts — Auto Parts in District 5">Phụ Tùng Trường Sơn — Phụ tùng ô tô Quận 5</title>',
  '<meta name="description" data-desc-vi="Mô tả mẫu phụ tùng." data-desc-en="Sample auto parts description." content="Mô tả mẫu phụ tùng.">',
  '</head>',
  '<body>',
  '<header><a class="logo"><span data-vi="Phụ Tùng Ô Tô Trường Sơn" data-en="Truong Son Auto Parts">Phụ Tùng Ô Tô Trường Sơn</span></a></header>',
  '<p>Phụ tùng ô tô · Quận 5</p>',
  '<p>Địa chỉ mẫu, Quận 5, TP. Hồ Chí Minh</p>',
  '<p>0967 136 099</p>',
  '<p>lien-he@vi-du.vn</p>',
  '<p>7:30 – 18:30, Thứ 2 – Thứ 7</p>',
  '<p>Kho 3.000 mã phụ tùng · giao trong ngày nội thành</p>',
  '</body>',
  '</html>',
].join('\n');

const TWIN_SEED = {
  site: {
    name: { vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' },
    tagline: { vi: 'Phụ tùng ô tô · Quận 5', en: 'Auto Parts Store · District 5' },
    address: { vi: 'Địa chỉ mẫu, Quận 5, TP. Hồ Chí Minh', en: 'Sample address, District 5, Ho Chi Minh City' },
    phone: '0967 136 099',
    email: 'lien-he@vi-du.vn',
    hours: { vi: '7:30 – 18:30, Thứ 2 – Thứ 7', en: '7:30 AM – 6:30 PM, Mon – Sat' },
    capacity: { vi: 'Kho 3.000 mã phụ tùng · giao trong ngày nội thành', en: 'Warehouse of 3,000 part codes' },
  },
  ui: { metaDesc: { vi: 'Mô tả mẫu phụ tùng.', en: 'Sample auto parts description.' } },
  seo: {
    title: { vi: '', en: '' },
    description: { vi: '', en: '' },
    businessType: 'AutoPartsStore',
    openingHours: 'Mo-Sa 07:30-18:30',
  },
};

interface LookupRow {
  id: string;
  owner_id: string;
  status: string;
  runtime_port: number | null;
  template_version_id: string;
  display_name: string;
  updated_at: string;
  adapter: string;
  template_id: string;
  category_code: string;
}

let upstream: Server;
let upstreamPort: number;
let router: Server;
let routerPort: number;
let upstreamRobotsHits = 0;

const SITES = new Map<string, LookupRow>();
const SETUP = new Map<string, Record<string, unknown>>();

function fakeDb(): Db {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('service_tasks')) {
        const site = [...SITES.values()].find((s) => s.id === params[0]);
        const info = site ? SETUP.get(site.id) : undefined;
        return { rows: info ? [{ setup_info_json: info }] : [] };
      }
      if (sql.includes("'-dong'")) {
        return { rows: params[0] === 'ver-auto' ? [{ published_version_id: 'twin-ver-1' }] : [] };
      }
      if (sql.includes('JOIN artifacts')) {
        return { rows: params[0] === 'twin-ver-1' ? [{ object_key: 'seo-test/twin' }] : [] };
      }
      if (sql.includes('template_translations')) {
        return { rows: [{ locale: 'vi', summary: 'Mẫu landing cho cửa hàng.' }] };
      }
      if (sql.includes('FROM domains')) return { rows: [] };
      if (sql.includes('FROM sites')) return { rows: SITES.has(params[0] as string) ? [SITES.get(params[0] as string)] : [] };
      return { rows: [] };
    },
  } as unknown as Db;
}

function call(port: number, host: string, path: string, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

function jsonLdOf(html: string): Record<string, unknown> {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no JSON-LD script in HTML');
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt') {
      upstreamRobotsHits++;
      res.setHeader('content-type', 'text/plain');
      res.end('UPSTREAM-ROBOTS');
      return;
    }
    if (url === '/sitemap.xml' || url === '/llms.txt') {
      res.setHeader('content-type', 'text/html');
      res.end(STATIC_HTML);
      return;
    }
    if (url === '/styles.css') {
      res.setHeader('content-type', 'text/css');
      res.end('body{margin:0}');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(STATIC_HTML);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const storageDir = await mkdtemp(join(tmpdir(), 'seo-router-test-'));
  const seedDir = join(storageDir, 'seo-test', 'twin', 'public');
  await mkdir(seedDir, { recursive: true });
  await writeFile(join(seedDir, 'seed.json'), JSON.stringify(TWIN_SEED));

  SITES.set('auto-shop', { id: 'site-auto', owner_id: 'owner-1', status: 'active', runtime_port: upstreamPort, template_version_id: 'ver-auto', display_name: 'Auto Shop Display', updated_at: '2026-10-15T08:30:00.000Z', adapter: 'static-html', template_id: 'tpl-auto', category_code: 'automotive' });
  SITES.set('food-shop', { id: 'site-food', owner_id: 'owner-1', status: 'active', runtime_port: upstreamPort, template_version_id: 'ver-food', display_name: 'Food Display', updated_at: '2026-09-01T00:00:00.000Z', adapter: 'vite-static', template_id: 'tpl-food', category_code: 'food' });
  SITES.set('dyn-shop', { id: 'site-dyn', owner_id: 'owner-1', status: 'active', runtime_port: upstreamPort, template_version_id: 'ver-dyn', display_name: 'Dyn Display', updated_at: '2026-10-01T00:00:00.000Z', adapter: 'node-http', template_id: 'tpl-dyn', category_code: 'business' });
  SITES.set('paused-static', { id: 'site-paused', owner_id: 'owner-1', status: 'suspended', runtime_port: upstreamPort, template_version_id: 'ver-auto', display_name: 'Paused', updated_at: '2026-10-15T08:30:00.000Z', adapter: 'static-html', template_id: 'tpl-auto', category_code: 'automotive' });
  SETUP.set('site-food', { business_name: 'Bếp Ngon Sài Gòn', phone: '0909 111 222', address: '123 Đường Khách, Quận 1', seo_description: 'Mô tả SEO của khách', source: 'form' });

  router = createSiteRouterServer({ config: { siteBaseDomain: BASE, previewBaseDomain: 'preview.localhost' }, db: fakeDb(), cacheMs: 0, restartCooldownMs: 0, storageDir });
  await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
  routerPort = (router.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => router.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('serve-time SEO for hosted static sites', () => {
  it('generates robots.txt at the router (never proxied), with the AI-crawler allows and the Sitemap line', async () => {
    upstreamRobotsHits = 0;
    const res = await call(routerPort, `auto-shop.${BASE}`, '/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('User-agent: *\nAllow: /');
    expect(res.body).toContain('User-agent: GPTBot\nAllow: /');
    expect(res.body).toContain('User-agent: Claude-SearchBot\nAllow: /');
    expect(res.body).toContain('User-agent: PerplexityBot\nAllow: /');
    expect(res.body.trimEnd().endsWith(`Sitemap: https://auto-shop.${BASE}/sitemap.xml`)).toBe(true);
    expect(upstreamRobotsHits).toBe(0);
  });

  it('generates sitemap.xml with the request host and the site row\'s real updated_at as lastmod', async () => {
    const res = await call(routerPort, `auto-shop.${BASE}`, '/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toContain(`<loc>https://auto-shop.${BASE}/</loc><lastmod>2026-10-15</lastmod>`);
  });

  it('generates llms.txt from the twin seed identity verified against the served homepage', async () => {
    const res = await call(routerPort, `auto-shop.${BASE}`, '/llms.txt');
    expect(res.status).toBe(200);
    expect(res.body).toContain('# Phụ Tùng Ô Tô Trường Sơn');
    expect(res.body).toContain('Loại hình / Business type: AutoPartsStore');
    expect(res.body).toContain('Địa chỉ / Address: Địa chỉ mẫu, Quận 5, TP. Hồ Chí Minh');
    expect(res.body).toContain('Điện thoại / Phone: 0967 136 099');
    expect(res.body).toContain('Email: lien-he@vi-du.vn');
    expect(res.body).toContain(`Website: https://auto-shop.${BASE}/`);
    expect(res.body).toContain(`Sitemap: https://auto-shop.${BASE}/sitemap.xml`);
  });

  it('injects JSON-LD into the static homepage head — and changes nothing else', async () => {
    const res = await call(routerPort, `auto-shop.${BASE}`, '/');
    expect(res.status).toBe(200);
    const ld = jsonLdOf(res.body);
    expect(ld['@type']).toBe('AutoPartsStore');
    expect(ld.name).toBe('Phụ Tùng Ô Tô Trường Sơn');
    expect(ld.url).toBe(`https://auto-shop.${BASE}/`);
    expect(ld.telephone).toBe('0967 136 099');
    expect(ld.openingHours).toBe('Mo-Sa 07:30-18:30');
    // Removing the injected script restores the upstream bytes exactly.
    const stripped = res.body.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
    expect(stripped).toBe(STATIC_HTML);
  });

  it('setup info wins over the seed layer, and the category map supplies the @type (food → Restaurant)', async () => {
    const res = await call(routerPort, `food-shop.${BASE}`, '/');
    const ld = jsonLdOf(res.body);
    expect(ld['@type']).toBe('Restaurant');
    expect(ld.name).toBe('Bếp Ngon Sài Gòn');
    expect(ld.description).toBe('Mô tả SEO của khách');
    expect(ld.telephone).toBe('0909 111 222');
    expect(ld.address).toEqual({ '@type': 'PostalAddress', streetAddress: '123 Đường Khách, Quận 1', addressCountry: 'VN' });
    const llms = await call(routerPort, `food-shop.${BASE}`, '/llms.txt');
    expect(llms.body).toContain('# Bếp Ngon Sài Gòn');
    expect(llms.body).toContain('Loại hình / Business type: Restaurant');
    const sitemap = await call(routerPort, `food-shop.${BASE}`, '/sitemap.xml');
    expect(sitemap.body).toContain('<lastmod>2026-09-01</lastmod>');
  });

  it('passes non-SEO paths of static sites through byte-identically', async () => {
    const css = await call(routerPort, `auto-shop.${BASE}`, '/styles.css');
    expect(css.status).toBe(200);
    expect(css.body).toBe('body{margin:0}');
  });

  it('intercepts GET only: a POST to /robots.txt is proxied like any other request', async () => {
    upstreamRobotsHits = 0;
    const res = await call(routerPort, `auto-shop.${BASE}`, '/robots.txt', 'POST');
    expect(res.body).toBe('UPSTREAM-ROBOTS');
    expect(upstreamRobotsHits).toBe(1);
  });
});

describe('SEO safety: everything else keeps today\'s behavior', () => {
  it('does not intercept a dynamic site: its own robots/sitemap are proxied and its HTML is not injected', async () => {
    const robots = await call(routerPort, `dyn-shop.${BASE}`, '/robots.txt');
    expect(robots.body).toBe('UPSTREAM-ROBOTS');
    const sitemap = await call(routerPort, `dyn-shop.${BASE}`, '/sitemap.xml');
    expect(sitemap.body).toBe(STATIC_HTML);
    const home = await call(routerPort, `dyn-shop.${BASE}`, '/');
    expect(home.body).toBe(STATIC_HTML);
    expect(home.body).not.toContain('application/ld+json');
  });

  it('keeps the suspended page for a suspended static site, SEO paths included', async () => {
    expect((await call(routerPort, `paused-static.${BASE}`, '/robots.txt')).status).toBe(403);
    expect((await call(routerPort, `paused-static.${BASE}`, '/sitemap.xml')).status).toBe(403);
  });

  it('404s SEO paths on unknown hosts exactly like any other path', async () => {
    expect((await call(routerPort, `nope.${BASE}`, '/robots.txt')).status).toBe(404);
    expect((await call(routerPort, 'unknown.example.com', '/llms.txt')).status).toBe(404);
  });
});

describe('seo helpers', () => {
  const identity: SeoIdentity = {
    nameVi: 'Tên Mẫu', nameEn: '', descVi: '', descEn: '', phone: '', email: '',
    addressVi: '', addressEn: '', taglineVi: '', taglineEn: '', hoursVi: '', hoursEn: '',
    aboutVi: '', businessType: 'Store', openingHours: '',
  };

  it('injectSeoJsonLd leaves a page that already carries JSON-LD untouched', () => {
    const html = '<html><head><script type="application/ld+json">{}</script></head><body></body></html>';
    expect(injectSeoJsonLd(html, identity, 'https://x.example')).toBe(html);
  });

  it('injectSeoJsonLd leaves a headless page untouched', () => {
    const html = '<html><body>hi</body></html>';
    expect(injectSeoJsonLd(html, identity, 'https://x.example')).toBe(html);
  });

  it('identityFromHtmlHead reads the bilingual title/description the freeze rendered', () => {
    const head = identityFromHtmlHead(STATIC_HTML);
    expect(head.title.vi).toBe('Phụ Tùng Trường Sơn — Phụ tùng ô tô Quận 5');
    expect(head.title.en).toBe('Truong Son Auto Parts — Auto Parts in District 5');
    expect(head.description.vi).toBe('Mô tả mẫu phụ tùng.');
    expect(head.description.en).toBe('Sample auto parts description.');
  });
});
