import { createHash } from 'node:crypto';
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { ROUTER_PROBE_BODY, ROUTER_PROBE_PATH, enqueueJob, writeAudit, type Db, type PlatformConfig } from '@3t/core';
import { EDITOR_SCRIPT } from './editor-script.ts';
import { injectSeoJsonLd, isStaticAdapter, resolveSeoIdentity, seoLlmsTxt, seoRobotsTxt, seoSitemapXml, type SeoIdentity } from './seo.ts';

/**
 * Hosted-site router (docs: site-router design, 2026-10-29). The public entry
 * point for customer sites: it maps the request Host to a site row and reverse
 * proxies to that site's own server process (worker-provisioned, one port per
 * site). Hosts resolve two ways:
 * - <subdomain>.<siteBaseDomain> via sites.subdomain (platform subdomains);
 * - any other host via the domains table, verified rows only (custom domains).
 *
 * It also carries runtime DEMO sessions on the preview origin:
 * <previewBaseDomain>/session/<uuid>/... proxies to the session server the
 * API spawned, so a dynamic template's demo (including its admin) is publicly
 * reachable without exposing a loopback URL. The tunnel routes that one path
 * prefix here; every other preview path stays with the preview origin.
 *
 * Upstreams: site processes live in the worker's network namespace and demo
 * session processes in the API's, so the connect host is configurable
 * (loopback for single-host dev; the compose service name in production).
 * The ports themselves are never published outside the stack.
 *
 * Unlike the preview origin this server is deliberately transparent for site
 * traffic: hosted sites are the customer's production website, so no platform
 * headers are injected and no cookies are touched. Portal session cookies are
 * host-only (ADR-005), so a customer subdomain can never read them.
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
const SESSION_PATH_RE = /^\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/;

/**
 * Demo runtimes are written to be served from a domain root (that is where a
 * buyer's own deployment lives), so their HTML uses root-absolute URLs
 * ("/styles.css", "/images/hero.jpg", form actions and fetch() calls under
 * "/admin", "/api", "/uploads"). Behind the session prefix those URLs escape
 * the session and 404 — the page renders without CSS or images. The router is
 * the one layer that knows the prefix, so it rewrites root-absolute URLs in
 * HTML responses, redirect targets and cookie paths back under the session
 * prefix. Site traffic is never rewritten: hosted sites really are at a root.
 */
function rewriteSessionHtml(html: string, prefix: string): string {
  let out = html.replace(/(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)(?!session\/)/gi, `$1${prefix}/`);
  out = out.replace(/(["'])\/(api|admin|uploads|images|files)\//g, `$1${prefix}/$2/`);
  out = out.replace(/(["'])\/styles\.css\b/g, `$1${prefix}/styles.css`);
  out = out.replace(/url\((\s*["']?)\/(?!\/)(?!session\/)/g, `url($1${prefix}/`);
  return out;
}

function rewriteSessionLocation(location: string, prefix: string): string {
  if (location.startsWith('/') && !location.startsWith('//') && location !== prefix && !location.startsWith(`${prefix}/`)) {
    return prefix + location;
  }
  return location;
}

function rewriteSessionCookie(cookie: string, prefix: string): string {
  return cookie.replace(/;\s*path=\/(?=;|$)/i, `; Path=${prefix}/`);
}

interface SiteTarget {
  siteId: string;
  ownerId: string;
  status: string;
  runtimePort: number | null;
  /** SEO facts (serve-time generation for hosted statics, see seo.ts).
   *  Null/absent for rows the lookup could not join — treated as
   *  "not a static site", i.e. plain passthrough. */
  adapter: string | null;
  categoryCode: string | null;
  templateId: string | null;
  templateVersionId: string | null;
  displayName: string;
  /** sites.updated_at as ISO; the sitemap's truthful lastmod source. */
  updatedAt: string | null;
}

/**
 * Visual editor for hosted static sites (migration 0046) — the router is
 * the platform surface on the site's own origin: the API mints a
 * short-lived edit session from the buyer's marketplace session, the
 * buyer lands here with the one-time token, and from then on a cookie
 * authorizes (a) injecting the editor into this site's HTML and
 * (b) the one-shot finalize, which claims the SAME one-time setup right
 * the order-page form spends (service_tasks.setup_info_submitted_at)
 * and enqueues the worker job that backs up + rewrites the files.
 * Requests without a valid session cookie are proxied byte-identically:
 * the editor is invisible to the public site.
 */
const EDIT_PREFIX = '/__3t_edit/';
const EDIT_COOKIE = '__3t_edit';
const EDIT_BODY_CAP = 512 * 1024;

interface EditCandidateRow {
  id: string;
  kind: 'text' | 'image';
  vi?: string;
  en?: string;
  url?: string;
}

interface EditSessionRow {
  id: string;
  site_id: string;
  buyer_id: string;
  task_id: string;
  candidates_json: EditCandidateRow[];
  job_id: string | null;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

function tokenHashHex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

function jsonReply(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex');
  res.end(JSON.stringify(body));
}

function injectEditor(html: string, session: EditSessionRow): string {
  const boot = {
    candidates: session.candidates_json,
    finalizeUrl: '/__3t_edit/finalize',
    statusUrl: '/__3t_edit/status',
    exitUrl: '/__3t_edit/exit',
  };
  const tag = `<script>window.__3T_EDIT__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script><script src="/__3t_edit/editor.js"></script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

export interface SiteRouterDeps {
  config: Pick<PlatformConfig, 'siteBaseDomain' | 'previewBaseDomain'>;
  db: Db;
  /** Where site processes are reachable (worker namespace). Default loopback. */
  sitesUpstreamHost?: string;
  /** Where demo session processes are reachable (API namespace). Default loopback. */
  sessionsUpstreamHost?: string;
  /** Cache lifetime for host lookups; a domain detach takes effect within this window. */
  cacheMs?: number;
  /** Minimum gap between auto-restart enqueues for the same site. */
  restartCooldownMs?: number;
  /** Object-store root (config.storageDir): lets the SEO identity
   *  resolver read the dynamic twin's seed for hosted static sites.
   *  Optional — without a readable store the resolver falls back to
   *  the site's served HTML head (see seo.ts). */
  storageDir?: string;
  /** Cache lifetime for resolved SEO identities of static sites. */
  seoCacheMs?: number;
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
  const previewDomain = deps.config.previewBaseDomain.toLowerCase();
  const suffix = `.${baseDomain}`;
  const sitesHost = deps.sitesUpstreamHost ?? '127.0.0.1';
  const sessionsHost = deps.sessionsUpstreamHost ?? '127.0.0.1';
  const cacheMs = deps.cacheMs ?? 5000;
  const restartCooldownMs = deps.restartCooldownMs ?? 60_000;
  const cache = new Map<string, { at: number; target: SiteTarget | null }>();
  const sessionCache = new Map<string, { at: number; port: number | null }>();
  const lastRestart = new Map<string, number>();
  const seoCacheMs = deps.seoCacheMs ?? 60_000;
  const seoCache = new Map<string, { at: number; identity: SeoIdentity }>();

  interface SiteLookupRow {
    id: string;
    owner_id: string;
    status: string;
    runtime_port: number | null;
    template_version_id: string | null;
    display_name: string | null;
    updated_at: Date | string | null;
    adapter: string | null;
    template_id: string | null;
    category_code: string | null;
  }

  function toTarget(row: SiteLookupRow): SiteTarget {
    return {
      siteId: row.id,
      ownerId: row.owner_id,
      status: row.status,
      runtimePort: row.runtime_port,
      adapter: row.adapter ?? null,
      categoryCode: row.category_code ?? null,
      templateId: row.template_id ?? null,
      templateVersionId: row.template_version_id ?? null,
      displayName: row.display_name ?? '',
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async function lookup(host: string): Promise<SiteTarget | null> {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < cacheMs) return hit.target;
    let target: SiteTarget | null = null;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (!label.includes('.') && SUBDOMAIN_RE.test(label) && !RESERVED.has(label)) {
        const { rows } = await deps.db.query<SiteLookupRow>(
          `SELECT s.id, s.owner_id, s.status, s.runtime_port, s.template_version_id, s.display_name, s.updated_at,
                  tv.adapter, t.id AS template_id, tc.code AS category_code
           FROM sites s
           JOIN template_versions tv ON tv.id = s.template_version_id
           JOIN templates t ON t.id = tv.template_id
           LEFT JOIN template_categories tc ON tc.id = t.category_id
           WHERE s.subdomain = $1 LIMIT 1`,
          [label],
        );
        const row = rows[0];
        if (row) target = toTarget(row);
      }
    } else if (host !== baseDomain) {
      const { rows } = await deps.db.query<SiteLookupRow>(
        `SELECT s.id, s.owner_id, s.status, s.runtime_port, s.template_version_id, s.display_name, s.updated_at,
                tv.adapter, t.id AS template_id, tc.code AS category_code
         FROM domains d JOIN sites s ON s.id = d.site_id
         JOIN template_versions tv ON tv.id = s.template_version_id
         JOIN templates t ON t.id = tv.template_id
         LEFT JOIN template_categories tc ON tc.id = t.category_id
         WHERE d.hostname_ascii = $1 AND d.status = 'verified' LIMIT 1`,
        [host],
      );
      const row = rows[0];
      if (row) target = toTarget(row);
    }
    cache.set(host, { at: Date.now(), target });
    if (cache.size > 10_000) cache.clear();
    return target;
  }

  async function lookupSessionPort(sessionId: string): Promise<number | null> {
    const hit = sessionCache.get(sessionId);
    if (hit && Date.now() - hit.at < cacheMs) return hit.port;
    const { rows } = await deps.db.query<{ runtime_port: number }>(
      "SELECT runtime_port FROM demo_sessions WHERE id = $1 AND status = 'active' AND expires_at > now() AND runtime_port IS NOT NULL LIMIT 1",
      [sessionId],
    );
    const port = rows[0]?.runtime_port ?? null;
    sessionCache.set(sessionId, { at: Date.now(), port });
    if (sessionCache.size > 10_000) sessionCache.clear();
    return port;
  }

  /**
   * Serve-time SEO for hosted STATIC sites (see seo.ts for the data
   * rules). The public origin of a hosted site is always https behind
   * the tunnel; x-forwarded-proto wins when a proxy chain sets it.
   */
  function seoBase(req: IncomingMessage, host: string): string {
    const forwarded = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    return `${forwarded || 'https'}://${host}`;
  }

  /** The site's own served homepage, read straight from its process —
   *  the corpus the SEO identity's seed strings are verified against
   *  and the head the fallback layer reads. '' on any failure: the
   *  identity then rests on DB sources alone. */
  function fetchHomepageHtml(target: SiteTarget, host: string): Promise<string> {
    if (!target.runtimePort) return Promise.resolve('');
    return new Promise((resolve) => {
      const up = httpRequest(
        { host: sitesHost, port: target.runtimePort!, method: 'GET', path: '/', headers: { host, 'accept-encoding': 'identity' } },
        (upRes) => {
          const contentType = String(upRes.headers['content-type'] ?? '');
          if ((upRes.statusCode ?? 0) !== 200 || !contentType.includes('text/html')) {
            upRes.resume();
            return resolve('');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          upRes.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 2 * 1024 * 1024) chunks.push(chunk);
          });
          upRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          upRes.on('error', () => resolve(''));
        },
      );
      up.setTimeout(5_000, () => up.destroy(new Error('seo homepage fetch timeout')));
      up.on('error', () => resolve(''));
      up.end();
    });
  }

  async function seoIdentityFor(target: SiteTarget, host: string): Promise<SeoIdentity> {
    const hit = seoCache.get(target.siteId);
    if (hit && Date.now() - hit.at < seoCacheMs) return hit.identity;
    // SEO must never take a customer page down: any failure degrades
    // to the DB-only identity (display name + category type).
    const identity = await (async () => {
      try {
        const homepageHtml = await fetchHomepageHtml(target, host);
        return await resolveSeoIdentity({
          db: deps.db,
          storageDir: deps.storageDir,
          homepageHtml,
          facts: {
            siteId: target.siteId,
            templateId: target.templateId,
            templateVersionId: target.templateVersionId,
            categoryCode: target.categoryCode,
            displayName: target.displayName,
          },
        });
      } catch {
        return {
          nameVi: target.displayName, nameEn: '', descVi: '', descEn: '', phone: '', email: '',
          addressVi: '', addressEn: '', taglineVi: '', taglineEn: '', hoursVi: '', hoursEn: '',
          aboutVi: '', businessType: 'LocalBusiness', openingHours: '',
        } satisfies SeoIdentity;
      }
    })();
    seoCache.set(target.siteId, { at: Date.now(), identity });
    if (seoCache.size > 10_000) seoCache.clear();
    return identity;
  }

  /** Same response contract as the dynamic engine's sendText(). */
  function sendSeoText(res: ServerResponse, body: string, contentType: string) {
    res.statusCode = 200;
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'public, max-age=3600');
    res.end(body);
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

  async function loadEditSession(token: string): Promise<EditSessionRow | null> {
    if (!token) return null;
    const { rows } = await deps.db.query<EditSessionRow>(
      'SELECT id, site_id, buyer_id, task_id, candidates_json, job_id, expires_at, consumed_at FROM site_edit_sessions WHERE token_hash = $1 LIMIT 1',
      [tokenHashHex(token)],
    );
    return rows[0] ?? null;
  }

  function editSessionLive(session: EditSessionRow, siteId: string): boolean {
    return session.site_id === siteId && !session.consumed_at && new Date(session.expires_at).getTime() > Date.now();
  }

  function readBody(req: IncomingMessage, cap: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) {
          reject(new Error('body_too_large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** The /__3t_edit/* platform surface on a resolved site's origin. */
  async function handleEditRoute(req: IncomingMessage, res: ServerResponse, target: SiteTarget, pathname: string, rawUrl: string): Promise<void> {
    const action = pathname.slice(EDIT_PREFIX.length);

    if (action === 'editor.js' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-robots-tag', 'noindex');
      res.end(EDITOR_SCRIPT);
      return;
    }

    if (action === 'enter' && req.method === 'GET') {
      let token = '';
      try {
        token = new URL(rawUrl, 'http://router.local').searchParams.get('token') ?? '';
      } catch {
        token = '';
      }
      const session = token ? await loadEditSession(token) : null;
      if (!session || !editSessionLive(session, target.siteId)) {
        return plain(res, 403, 'Edit session invalid or expired. / Phiên sửa đã hết hạn hoặc không hợp lệ.');
      }
      const maxAge = Math.max(1, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000));
      const secure = (req.headers['x-forwarded-proto'] as string | undefined) === 'https' ? '; Secure' : '';
      res.statusCode = 302;
      res.setHeader('location', '/');
      res.setHeader('set-cookie', `${EDIT_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
      res.setHeader('x-robots-tag', 'noindex');
      res.end();
      return;
    }

    if (action === 'exit') {
      res.statusCode = 302;
      res.setHeader('location', '/');
      res.setHeader('set-cookie', `${EDIT_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
      res.end();
      return;
    }

    const cookieToken = parseCookies(req).get(EDIT_COOKIE) ?? '';
    const session = cookieToken ? await loadEditSession(cookieToken) : null;
    if (!session || session.site_id !== target.siteId) {
      return jsonReply(res, 403, { error: 'edit_session_invalid' });
    }

    if (action === 'status' && req.method === 'GET') {
      if (!session.job_id) return jsonReply(res, 200, { state: session.consumed_at ? 'applying' : 'editing' });
      const { rows } = await deps.db.query<{ status: string; last_error_code: string | null; result_json: unknown }>(
        'SELECT status, last_error_code, result_json FROM jobs WHERE id = $1',
        [session.job_id],
      );
      const job = rows[0];
      if (!job) return jsonReply(res, 200, { state: 'applying' });
      if (job.status === 'succeeded') return jsonReply(res, 200, { state: 'done', result: job.result_json ?? null });
      if (job.status === 'failed' || job.status === 'dead') return jsonReply(res, 200, { state: 'failed', error_code: job.last_error_code ?? null });
      return jsonReply(res, 200, { state: 'applying' });
    }

    if (action === 'finalize' && req.method === 'POST') return handleEditFinalize(req, res, session);

    return plain(res, 404, 'Not Found');
  }

  /**
   * Finalize ordering — the invariant is that files never change while
   * the one-time right is unconsumed, and a consumed right always
   * leaves a staff-visible trail:
   *   1. consume the edit session (single-use, race-safe);
   *   2. enqueue the apply job (stable dedupe key = the session);
   *   3. atomically claim the setup right on the service task — the
   *      SAME `WHERE setup_info_submitted_at IS NULL` guard the form
   *      door uses, so the two doors can never both win;
   *   4. audit.
   * If the form won the race, step 3 matches no row: the buyer gets an
   * honest 409, and the queued job (its worker-side claim check finds
   * no visual-editor claim) fails visibly as visual_edit_claim_missing
   * without touching a single file.
   */
  async function handleEditFinalize(req: IncomingMessage, res: ServerResponse, session: EditSessionRow): Promise<void> {
    if (session.consumed_at) return jsonReply(res, 409, { error: 'edit_session_consumed' });
    if (new Date(session.expires_at).getTime() <= Date.now()) return jsonReply(res, 403, { error: 'edit_session_expired' });
    let raw: string;
    try {
      raw = await readBody(req, EDIT_BODY_CAP);
    } catch {
      return jsonReply(res, 413, { error: 'body_too_large' });
    }
    let parsed: { changes?: unknown };
    try {
      parsed = JSON.parse(raw) as { changes?: unknown };
    } catch {
      return jsonReply(res, 400, { error: 'invalid_body' });
    }
    const changes = Array.isArray(parsed.changes) ? parsed.changes : null;
    if (!changes || changes.length < 1 || changes.length > 100) return jsonReply(res, 400, { error: 'invalid_changes' });
    const byId = new Map(session.candidates_json.map((c) => [c.id, c]));
    const pairs: { from: string; to: string }[] = [];
    const summary: Record<string, string>[] = [];
    for (const change of changes as Array<Record<string, unknown>>) {
      const candidate = typeof change?.id === 'string' ? byId.get(change.id) : undefined;
      if (!candidate) return jsonReply(res, 400, { error: 'unknown_candidate' });
      if (candidate.kind === 'image') {
        const to = typeof change.url === 'string' ? change.url.trim() : '';
        if (!to || to === candidate.url) continue;
        if (to.length > 1000 || !/^https?:\/\//i.test(to)) return jsonReply(res, 400, { error: 'invalid_image_url' });
        pairs.push({ from: candidate.url!, to });
        summary.push({ field: candidate.id, image_from: candidate.url!, image_to: to });
        continue;
      }
      const entry: Record<string, string> = { field: candidate.id };
      for (const loc of ['vi', 'en'] as const) {
        const from = candidate[loc];
        const rawTo = change[loc];
        if (rawTo === undefined) continue;
        if (typeof rawTo !== 'string') return jsonReply(res, 400, { error: 'invalid_value' });
        const to = rawTo.trim();
        if (!to || to.length > 2000) return jsonReply(res, 400, { error: 'invalid_value' });
        if (from === undefined || to === from) continue;
        pairs.push({ from, to });
        entry[`${loc}_from`] = from;
        entry[`${loc}_to`] = to;
      }
      if (Object.keys(entry).length > 1) summary.push(entry);
    }
    if (pairs.length === 0) return jsonReply(res, 400, { error: 'no_changes' });

    const consumed = await deps.db.query<{ id: string }>(
      'UPDATE site_edit_sessions SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING id',
      [session.id],
    );
    if (consumed.rows.length === 0) return jsonReply(res, 409, { error: 'edit_session_consumed' });
    const { job } = await enqueueJob(deps.db, {
      type: 'site.visual_edit_apply',
      dedupeKey: `site.visual_edit_apply:${session.id}`,
      payload: { site_id: session.site_id, task_id: session.task_id, session_id: session.id, pairs },
      resourceType: 'site',
      resourceId: session.site_id,
      ownerId: session.buyer_id,
    });
    await deps.db.query('UPDATE site_edit_sessions SET job_id = $1 WHERE id = $2', [job.id, session.id]);
    const setupInfo: Record<string, unknown> = { source: 'visual_editor', session_id: session.id, changes: summary };
    for (const entry of summary) {
      if (entry.field === 'site.name') setupInfo.business_name = entry.vi_to ?? entry.en_to;
      if (entry.field === 'site.phone') setupInfo.phone = entry.vi_to ?? entry.en_to;
      if (entry.field === 'site.address') setupInfo.address = entry.vi_to ?? entry.en_to;
      if (entry.field === 'site.email') setupInfo.email = entry.vi_to ?? entry.en_to;
    }
    const claim = await deps.db.query<{ id: string }>(
      'UPDATE service_tasks SET setup_info_json = $2::jsonb, setup_info_submitted_at = now() WHERE id = $1 AND setup_info_submitted_at IS NULL RETURNING id',
      [session.task_id, JSON.stringify(setupInfo)],
    );
    if (claim.rows.length === 0) return jsonReply(res, 409, { error: 'setup_info.already_submitted' });
    await writeAudit(deps.db, {
      actorType: 'user',
      actorId: session.buyer_id,
      action: 'site.visual_edit_finalized',
      resourceType: 'site',
      resourceId: session.site_id,
      traceId: session.id,
      diff: { changes: summary.length },
    });
    return jsonReply(res, 202, { job_id: job.id });
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

  function proxy(req: IncomingMessage, res: ServerResponse, upstreamHost: string, port: number, path: string, onDeadUpstream: () => void, sessionPrefix?: string, editSession?: EditSessionRow, seo?: { identity: SeoIdentity; base: string }) {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const clientIp = req.socket.remoteAddress ?? '';
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    }
    headers.host = host;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for'] as string}, ${clientIp}` : clientIp;
    if (sessionPrefix) {
      headers['x-forwarded-prefix'] = sessionPrefix;
      // HTML bodies are buffered for URL rewriting; keep them uncompressed.
      headers['accept-encoding'] = 'identity';
    }
    if (seo) {
      // HTML bodies are buffered for the JSON-LD injection; keep them
      // uncompressed. Non-HTML responses still stream untouched.
      headers['accept-encoding'] = 'identity';
    }
    if (editSession) {
      // HTML bodies are buffered for editor injection; keep them
      // uncompressed, and never leak the platform edit cookie to the
      // site's own process.
      headers['accept-encoding'] = 'identity';
      const kept = (typeof headers.cookie === 'string' ? headers.cookie : '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(`${EDIT_COOKIE}=`));
      if (kept.length > 0) headers.cookie = kept.join('; ');
      else delete headers.cookie;
    }
    const upstream = httpRequest(
      { host: upstreamHost, port, method: req.method, path, headers },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) outHeaders[name] = value;
        }
        if (sessionPrefix) {
          if (typeof outHeaders.location === 'string') outHeaders.location = rewriteSessionLocation(outHeaders.location, sessionPrefix);
          if (Array.isArray(outHeaders['set-cookie'])) outHeaders['set-cookie'] = outHeaders['set-cookie'].map((c) => rewriteSessionCookie(c, sessionPrefix));
          else if (typeof outHeaders['set-cookie'] === 'string') outHeaders['set-cookie'] = rewriteSessionCookie(outHeaders['set-cookie'], sessionPrefix);
          const contentType = String(outHeaders['content-type'] ?? '');
          const encoding = String(outHeaders['content-encoding'] ?? 'identity');
          if (contentType.includes('text/html') && (encoding === 'identity' || encoding === '')) {
            const chunks: Buffer[] = [];
            upRes.on('data', (chunk) => chunks.push(chunk as Buffer));
            upRes.on('end', () => {
              const body = rewriteSessionHtml(Buffer.concat(chunks).toString('utf8'), sessionPrefix);
              outHeaders['content-length'] = String(Buffer.byteLength(body));
              res.writeHead(upRes.statusCode ?? 502, outHeaders);
              res.end(body);
            });
            upRes.on('error', () => res.destroy());
            return;
          }
        }
        if (editSession && req.method === 'GET') {
          const contentType = String(outHeaders['content-type'] ?? '');
          const encoding = String(outHeaders['content-encoding'] ?? 'identity');
          if (contentType.includes('text/html') && (encoding === 'identity' || encoding === '')) {
            const chunks: Buffer[] = [];
            upRes.on('data', (chunk) => chunks.push(chunk as Buffer));
            upRes.on('end', () => {
              const body = injectEditor(Buffer.concat(chunks).toString('utf8'), editSession);
              outHeaders['content-length'] = String(Buffer.byteLength(body));
              outHeaders['cache-control'] = 'no-store';
              res.writeHead(upRes.statusCode ?? 502, outHeaders);
              res.end(body);
            });
            upRes.on('error', () => res.destroy());
            return;
          }
        }
        if (seo && req.method === 'GET') {
          const contentType = String(outHeaders['content-type'] ?? '');
          const encoding = String(outHeaders['content-encoding'] ?? 'identity');
          if (contentType.includes('text/html') && (encoding === 'identity' || encoding === '')) {
            const chunks: Buffer[] = [];
            upRes.on('data', (chunk) => chunks.push(chunk as Buffer));
            upRes.on('end', () => {
              const body = injectSeoJsonLd(Buffer.concat(chunks).toString('utf8'), seo.identity, seo.base);
              outHeaders['content-length'] = String(Buffer.byteLength(body));
              res.writeHead(upRes.statusCode ?? 502, outHeaders);
              res.end(body);
            });
            upRes.on('error', () => res.destroy());
            return;
          }
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      onDeadUpstream();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split(/[?#]/)[0] ?? '/';
    if (pathname === '/__health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!host) return plain(res, 400, 'Bad Request');

    // Custom-domain routing probe: the platform's domain verification asks
    // for this exact path on a buyer's hostname to learn whether traffic
    // actually arrives here (CNAME chains are invisible for apex
    // flattening/proxied setups). It answers ONLY the marker, ONLY for a
    // hostname present in the domains table as pending/verified — knowing
    // the path reveals nothing about sites and proxies nothing.
    if (pathname === ROUTER_PROBE_PATH) {
      const { rows } = await deps.db.query<{ one: number }>(
        "SELECT 1 AS one FROM domains WHERE hostname_ascii = $1 AND status IN ('pending', 'verified') LIMIT 1",
        [host],
      );
      if (!rows[0]) return plain(res, 404, 'Not Found');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-robots-tag', 'noindex');
      return res.end(ROUTER_PROBE_BODY);
    }

    // Demo sessions live on the preview origin under /session/<uuid>/.
    if (host === previewDomain && pathname.startsWith('/session/')) {
      const match = SESSION_PATH_RE.exec(pathname);
      if (!match) return plain(res, 404, 'Not Found');
      const sessionId = match[1]!;
      const rest = match[2] ?? '';
      const query = rawUrl.slice(pathname.length);
      if (rest === '') {
        res.statusCode = 302;
        res.setHeader('location', `/session/${sessionId}/${query}`);
        return res.end();
      }
      const port = await lookupSessionPort(sessionId);
      if (!port) return plain(res, 404, 'Demo session not found or expired');
      return proxy(
        req, res, sessionsHost, port, rest + query,
        () => plain(res, 503, 'This demo is starting. Please try again in a few seconds. / Bản demo đang khởi động, vui lòng thử lại sau vài giây.', { 'retry-after': '15' }),
        `/session/${sessionId}`,
      );
    }

    const target = await lookup(host);
    if (!target) return plain(res, 404, 'Not Found');
    if (statusPage(res, target)) return;

    // Visual-editor platform surface on the site's own origin (see the
    // EDIT_PREFIX block above): token entry, the editor script, the
    // one-shot finalize and its status. None of it needs the site
    // process, so it is answered before the runtime check.
    if (pathname.startsWith(EDIT_PREFIX)) return handleEditRoute(req, res, target, pathname, rawUrl);

    if (!target.runtimePort) {
      maybeEnqueueRestart(target);
      return plain(res, 503, 'This site is being set up. Please try again shortly. / Trang web đang được khởi tạo, vui lòng quay lại sau ít phút.', { 'retry-after': '30' });
    }

    // Serve-time SEO for hosted STATIC sites (seo.ts): the three
    // generated files. Static bundles fall back to their homepage for
    // unknown paths, so without this interception they have no real
    // sitemap/robots/llms at all. Dynamic sites are never intercepted —
    // their own server generates these from live content.
    const isStatic = isStaticAdapter(target.adapter);
    if (isStatic && req.method === 'GET' && (pathname === '/robots.txt' || pathname === '/sitemap.xml' || pathname === '/llms.txt')) {
      const identity = await seoIdentityFor(target, host);
      const base = seoBase(req, host);
      if (pathname === '/robots.txt') return sendSeoText(res, seoRobotsTxt(base), 'text/plain; charset=utf-8');
      if (pathname === '/llms.txt') return sendSeoText(res, seoLlmsTxt(identity, base), 'text/plain; charset=utf-8');
      const lastmod = target.updatedAt ? target.updatedAt.slice(0, 10) : '';
      return sendSeoText(res, seoSitemapXml(base, lastmod), 'application/xml; charset=utf-8');
    }

    // Edit mode only ever comes from the buyer's own cookie; anything
    // else (no cookie, foreign, expired, consumed) proxies untouched.
    let editSession: EditSessionRow | undefined;
    if (req.method === 'GET') {
      const token = parseCookies(req).get(EDIT_COOKIE);
      if (token) {
        const session = await loadEditSession(token).catch(() => null);
        if (session && editSessionLive(session, target.siteId)) editSession = session;
      }
    }
    // JSON-LD injection rides the same response buffering as the
    // editor; while an edit session is live the editor owns the page
    // and SEO injection stands down.
    const seo = isStatic && req.method === 'GET' && !editSession
      ? { identity: await seoIdentityFor(target, host), base: seoBase(req, host) }
      : undefined;
    return proxy(req, res, sitesHost, target.runtimePort, rawUrl, () => {
      // An active site whose process is gone (worker/host restart) gets a
      // restart job; the visitor sees a retry page, not a dead end.
      maybeEnqueueRestart(target);
      plain(res, 503, 'This site is starting. Please try again in a few seconds. / Trang web đang khởi động lại, vui lòng thử lại sau vài giây.', { 'retry-after': '30' });
    }, undefined, editSession, seo);
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
      let upstreamHost: string | null = null;
      let port: number | null = null;
      let path = req.url ?? '/';
      if (host === previewDomain && path.startsWith('/session/')) {
        const qAt = path.search(/[?#]/);
        const onlyPath = qAt === -1 ? path : path.slice(0, qAt);
        const query = qAt === -1 ? '' : path.slice(qAt);
        const match = SESSION_PATH_RE.exec(onlyPath);
        if (match) {
          port = await lookupSessionPort(match[1]!);
          upstreamHost = sessionsHost;
          path = (match[2] ?? '/') + query;
        }
      } else if (host) {
        const target = await lookup(host);
        if (target && target.status !== 'suspended' && target.status !== 'delete_scheduled' && target.status !== 'purged' && target.runtimePort) {
          upstreamHost = sitesHost;
          port = target.runtimePort;
        }
      }
      if (!upstreamHost || !port) {
        socket.destroy();
        return;
      }
      const upstream = netConnect(port, upstreamHost, () => {
        const lines = [`${req.method ?? 'GET'} ${path} HTTP/${req.httpVersion}`];
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
