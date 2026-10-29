import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSiteRouterServer } from './server.ts';

const BASE = 'webmaket.local';

interface SiteRow {
  id: string;
  owner_id: string;
  status: string;
  runtime_port: number | null;
}

let upstream: Server;
let upstreamPort: number;
let deadPort: number;
let router: Server;
let routerPort: number;
const enqueued: unknown[][] = [];

const SITES = new Map<string, SiteRow>();
const DOMAINS = new Map<string, SiteRow>();
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EXPIRED_SESSION_ID = 'ffffffff-1111-4222-8333-444444444444';
const SESSIONS = new Map<string, number>();

function fakeDb(): Db {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO jobs')) {
        enqueued.push(params);
        return { rows: [{ id: 'job-1' }] };
      }
      if (sql.includes('FROM demo_sessions')) return { rows: SESSIONS.has(params[0] as string) ? [{ runtime_port: SESSIONS.get(params[0] as string) }] : [] };
      if (sql.includes('FROM domains')) return { rows: DOMAINS.has(params[0] as string) ? [DOMAINS.get(params[0] as string)] : [] };
      if (sql.includes('FROM sites')) return { rows: SITES.has(params[0] as string) ? [SITES.get(params[0] as string)] : [] };
      return { rows: [] };
    },
  } as unknown as Db;
}

function call(port: number, host: string, path: string, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, 'x-test': 'yes', ...(body ? { 'content-type': 'text/plain' } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectPromise);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      res.setHeader('x-upstream', 'yes');
      res.setHeader('set-cookie', 'site_session=abc; Path=/; HttpOnly');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, xtest: req.headers['x-test'] ?? null, host: req.headers.host ?? null, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  SITES.set('shop-one', { id: 'site-1', owner_id: 'owner-1', status: 'active', runtime_port: upstreamPort });
  SITES.set('paused-shop', { id: 'site-2', owner_id: 'owner-1', status: 'suspended', runtime_port: upstreamPort });
  SITES.set('new-shop', { id: 'site-3', owner_id: 'owner-1', status: 'creating', runtime_port: null });
  SITES.set('dead-shop', { id: 'site-4', owner_id: 'owner-1', status: 'active', runtime_port: deadPort });
  SITES.set('gone-shop', { id: 'site-5', owner_id: 'owner-1', status: 'delete_scheduled', runtime_port: upstreamPort });
  DOMAINS.set('shop.example.com', { id: 'site-6', owner_id: 'owner-2', status: 'active', runtime_port: upstreamPort });
  SESSIONS.set(SESSION_ID, upstreamPort);

  router = createSiteRouterServer({ config: { siteBaseDomain: BASE, previewBaseDomain: 'preview.localhost' }, db: fakeDb(), cacheMs: 0, restartCooldownMs: 0 });
  await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
  routerPort = (router.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => router.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('site router host resolution', () => {
  it('proxies a platform subdomain, preserving path, query, headers and cookies', async () => {
    const res = await call(routerPort, `shop-one.${BASE}`, '/menu?lang=vi');
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('yes');
    expect(res.headers['set-cookie']).toEqual(['site_session=abc; Path=/; HttpOnly']);
    const echoed = JSON.parse(res.body) as { url: string; xtest: string; host: string };
    expect(echoed.url).toBe('/menu?lang=vi');
    expect(echoed.xtest).toBe('yes');
    expect(echoed.host).toBe(`shop-one.${BASE}`);
  });

  it('forwards POST bodies to the site process', async () => {
    const res = await call(routerPort, `shop-one.${BASE}`, '/book', 'POST', 'name=An&guests=2');
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as { method: string; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body).toBe('name=An&guests=2');
  });

  it('proxies a verified custom domain', async () => {
    const res = await call(routerPort, 'shop.example.com', '/');
    expect(res.status).toBe(200);
    expect(res.headers['x-upstream']).toBe('yes');
  });

  it('404s unknown subdomains, the apex and reserved labels', async () => {
    expect((await call(routerPort, `nope.${BASE}`, '/')).status).toBe(404);
    expect((await call(routerPort, BASE, '/')).status).toBe(404);
    expect((await call(routerPort, `www.${BASE}`, '/')).status).toBe(404);
    expect((await call(routerPort, `a.b.${BASE}`, '/')).status).toBe(404);
    expect((await call(routerPort, 'unverified.example.com', '/')).status).toBe(404);
  });

  it('answers by site status: suspended 403, creating 503, deleting 410', async () => {
    expect((await call(routerPort, `paused-shop.${BASE}`, '/')).status).toBe(403);
    const creating = await call(routerPort, `new-shop.${BASE}`, '/');
    expect(creating.status).toBe(503);
    expect(creating.headers['retry-after']).toBe('30');
    expect((await call(routerPort, `gone-shop.${BASE}`, '/')).status).toBe(410);
  });

  it('enqueues a restart and answers 503 when an active site process is down', async () => {
    enqueued.length = 0;
    const res = await call(routerPort, `dead-shop.${BASE}`, '/');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(enqueued.length).toBeGreaterThanOrEqual(1);
    expect(enqueued[0]?.[0]).toBe('site.restart');
  });

  it('serves /__health on any host', async () => {
    const res = await call(routerPort, 'anything.example', '/__health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('demo session proxy on the preview origin', () => {
  it('proxies /session/<uuid>/... with the prefix stripped', async () => {
    const res = await call(routerPort, 'preview.localhost', `/session/${SESSION_ID}/admin?tab=menu`);
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as { url: string };
    expect(echoed.url).toBe('/admin?tab=menu');
  });

  it('redirects /session/<uuid> to the trailing slash', async () => {
    const res = await call(routerPort, 'preview.localhost', `/session/${SESSION_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/session/${SESSION_ID}/`);
  });

  it('404s expired or unknown sessions and malformed session paths', async () => {
    expect((await call(routerPort, 'preview.localhost', `/session/${EXPIRED_SESSION_ID}/`)).status).toBe(404);
    expect((await call(routerPort, 'preview.localhost', '/session/not-a-uuid/')).status).toBe(404);
  });

  it('does not treat other preview-origin paths as sessions', async () => {
    expect((await call(routerPort, 'preview.localhost', '/some-label/')).status).toBe(404);
  });
});
