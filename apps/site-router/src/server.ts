import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { enqueueJob, type Db, type PlatformConfig } from '@3t/core';

/**
 * Hosted-site router (docs: site-router design, 2026-10-29). The public entry
 * point for customer sites: it maps the request Host to a site row and reverse
 * proxies to that site's own server process on loopback (worker-provisioned,
 * one port per site). Hosts resolve two ways:
 * - <subdomain>.<siteBaseDomain> via sites.subdomain (platform subdomains);
 * - any other host via the domains table, verified rows only (custom domains).
 *
 * Unlike the preview origin this server is deliberately transparent: hosted
 * sites are the customer's production website, so no platform headers are
 * injected and no cookies are touched. Portal session cookies are host-only
 * (ADR-005), so a customer subdomain can never read them.
 *
 * Self-healing: site processes are children of the worker and die with it or
 * with the host. When an active site's upstream refuses a connection, the
 * router enqueues a site.restart job (deduplicated per minute + an in-process
 * cooldown) and answers 503, so the first visitor after a reboot brings the
 * site back instead of finding it dead.
 */
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const RESERVED = new Set(['admin', 'api', 'app', 'www', 'support', 'billing', 'static', 'preview', 'demo', 'mail', 'ftp', 'ns1', 'ns2', 'portal', 'account', 'auth', 'login', 'checkout', 'cdn', 'assets', 'root', 'system']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

interface SiteTarget {
  siteId: string;
  ownerId: string;
  status: string;
  runtimePort: number | null;
}

export interface SiteRouterDeps {
  config: Pick<PlatformConfig, 'siteBaseDomain'>;
  db: Db;
  /** Cache lifetime for host lookups; a domain detach takes effect within this window. */
  cacheMs?: number;
  /** Minimum gap between auto-restart enqueues for the same site. */
  restartCooldownMs?: number;
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('x-robots-tag', 'noindex');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(body);
}

export function createSiteRouterServer(deps: SiteRouterDeps): Server {
  const baseDomain = deps.config.siteBaseDomain.toLowerCase();
  const suffix = `.${baseDomain}`;
  const cacheMs = deps.cacheMs ?? 5000;
  const restartCooldownMs = deps.restartCooldownMs ?? 60_000;
  const cache = new Map<string, { at: number; target: SiteTarget | null }>();
  const lastRestart = new Map<string, number>();

  async function lookup(host: string): Promise<SiteTarget | null> {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < cacheMs) return hit.target;
    let target: SiteTarget | null = null;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (!label.includes('.') && SUBDOMAIN_RE.test(label) && !RESERVED.has(label)) {
        const { rows } = await deps.db.query<{ id: string; owner_id: string; status: string; runtime_port: number | null }>(
          'SELECT id, owner_id, status, runtime_port FROM sites WHERE subdomain = $1 LIMIT 1',
          [label],
        );
        const row = rows[0];
        if (row) target = { siteId: row.id, ownerId: row.owner_id, status: row.status, runtimePort: row.runtime_port };
      }
    } else if (host !== baseDomain) {
      const { rows } = await deps.db.query<{ id: string; owner_id: string; status: string; runtime_port: number | null }>(
        `SELECT s.id, s.owner_id, s.status, s.runtime_port FROM domains d JOIN sites s ON s.id = d.site_id
         WHERE d.hostname_ascii = $1 AND d.status = 'verified' LIMIT 1`,
        [host],
      );
      const row = rows[0];
      if (row) target = { siteId: row.id, ownerId: row.owner_id, status: row.status, runtimePort: row.runtime_port };
    }
    cache.set(host, { at: Date.now(), target });
    if (cache.size > 10_000) cache.clear();
    return target;
  }

  function maybeEnqueueRestart(target: SiteTarget): void {
    const now = Date.now();
    if (now - (lastRestart.get(target.siteId) ?? 0) < restartCooldownMs) return;
    lastRestart.set(target.siteId, now);
    void enqueueJob(deps.db, {
      type: 'site.restart',
      dedupeKey: `site.restart:auto:${target.siteId}:${Math.floor(now / 60_000)}`,
      payload: { site_id: target.siteId, auto: true },
      resourceType: 'site',
      resourceId: target.siteId,
      ownerId: target.ownerId,
    }).catch(() => undefined);
  }

  /** Answer for a resolved site that must not be proxied right now. */
  function statusPage(res: ServerResponse, target: SiteTarget): boolean {
    switch (target.status) {
      case 'active':
      case 'grace':
        return false;
      case 'suspended':
        plain(res, 403, 'This site is suspended. / Trang web này đang tạm ngưng.');
        return true;
      case 'delete_scheduled':
      case 'purged':
        plain(res, 410, 'This site is no longer available. / Trang web này không còn hoạt động.');
        return true;
      default: // creating, provision_failed, anything unexpected
        plain(res, 503, 'This site is being set up. Please try again shortly. / Trang web đang được khởi tạo, vui lòng quay lại sau ít phút.', { 'retry-after': '30' });
        return true;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const pathname = (req.url ?? '/').split(/[?#]/)[0];
    if (pathname === '/__health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!host) return plain(res, 400, 'Bad Request');
    const target = await lookup(host);
    if (!target) return plain(res, 404, 'Not Found');
    if (statusPage(res, target)) return;
    if (!target.runtimePort) {
      maybeEnqueueRestart(target);
      return plain(res, 503, 'This site is being set up. Please try again shortly. / Trang web đang được khởi tạo, vui lòng quay lại sau ít phút.', { 'retry-after': '30' });
    }
    const clientIp = req.socket.remoteAddress ?? '';
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    }
    headers.host = host;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for'] as string}, ${clientIp}` : clientIp;
    const upstream = httpRequest(
      { host: '127.0.0.1', port: target.runtimePort, method: req.method, path: req.url, headers },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) outHeaders[name] = value;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      // An active site whose process is gone (worker/host restart) gets a
      // restart job; the visitor sees a retry page, not a dead end.
      maybeEnqueueRestart(target);
      plain(res, 503, 'This site is starting. Please try again in a few seconds. / Trang web đang khởi động lại, vui lòng thử lại sau vài giây.', { 'retry-after': '30' });
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) plain(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });

  // WebSocket / raw upgrade tunnelling: replay the request head verbatim to
  // the site's own process and pipe both directions.
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    void (async () => {
      const target = host ? await lookup(host) : null;
      if (!target || target.status === 'suspended' || target.status === 'delete_scheduled' || target.status === 'purged' || !target.runtimePort) {
        socket.destroy();
        return;
      }
      const upstream = netConnect(target.runtimePort, '127.0.0.1', () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    })().catch(() => socket.destroy());
  });

  return server;
}
