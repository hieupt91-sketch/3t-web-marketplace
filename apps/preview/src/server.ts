import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, posix, sep } from 'node:path';
import type { Db, LocalObjectStore, PlatformConfig } from '@3t/core';

/**
 * Preview origin server (docs/03 §6–7). Serves immutable static artifacts by hostname label on a
 * registrable domain separate from the portal, so untrusted template HTML/JS can never read
 * portal cookies. No directory listing, no path escape, GET/HEAD only.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

interface PreviewTarget {
  root: string;
  entry: string;
  spaFallback: boolean;
}

export interface PreviewServerDeps {
  config: Pick<PlatformConfig, 'previewBaseDomain' | 'portalOrigin'>;
  db: Db;
  store: LocalObjectStore;
  /** Cache lifetime for host lookups; revocation takes effect within this window. */
  cacheMs?: number;
}

function securityHeaders(res: ServerResponse, portalOrigin: string) {
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', `frame-ancestors 'self' ${portalOrigin}`);
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
}

function plain(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

/** Map a request path to a safe relative file path, or null if it must be rejected. */
export function safeRequestPath(rawUrl: string): string | null {
  const pathname = rawUrl.split(/[?#]/)[0] ?? '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  const normalized = posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;
  const rel = normalized.replace(/^\/+/, '');
  if (rel.split('/').some((segment) => segment.startsWith('.') && segment.length > 0)) return null; // dotfiles
  return rel;
}

export function createPreviewServer(deps: PreviewServerDeps): Server {
  const cache = new Map<string, { at: number; target: PreviewTarget | null }>();
  const cacheMs = deps.cacheMs ?? 5000;
  const suffix = `.${deps.config.previewBaseDomain}`;

  async function lookup(label: string): Promise<PreviewTarget | null> {
    const hit = cache.get(label);
    if (hit && Date.now() - hit.at < cacheMs) return hit.target;
    const { rows } = await deps.db.query<{ entry: string; spa_fallback: boolean; object_key: string }>(
      `SELECT p.entry, p.spa_fallback, a.object_key FROM previews p JOIN artifacts a ON a.id = p.artifact_id
       WHERE p.host_label = $1 AND p.status = 'active' AND a.kind = 'static_site'`,
      [label],
    );
    const row = rows[0];
    const target = row ? { root: deps.store.pathFor(row.object_key), entry: row.entry, spaFallback: row.spa_fallback } : null;
    cache.set(label, { at: Date.now(), target });
    if (cache.size > 10_000) cache.clear();
    return target;
  }

  async function resolveFile(target: PreviewTarget, rel: string): Promise<string | null> {
    const candidates = rel === '' ? [target.entry] : [rel, posix.join(rel, 'index.html')];
    const rootReal = await realpath(target.root);
    for (const candidate of candidates) {
      const full = join(target.root, ...candidate.split('/'));
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        const real = await realpath(full);
        if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
        return real;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    securityHeaders(res, deps.config.portalOrigin);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return plain(res, 405, 'Method Not Allowed');
    }
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!host.endsWith(suffix)) return plain(res, 404, 'Not Found');
    const label = host.slice(0, -suffix.length);
    if (!/^[a-z0-9]{20,63}$/.test(label)) return plain(res, 404, 'Not Found');
    const target = await lookup(label);
    if (!target) return plain(res, 404, 'Preview not found or no longer available');
    const url = req.url ?? '/';
    if (url === '/__health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    const rel = safeRequestPath(url);
    if (rel === null) return plain(res, 400, 'Bad Request');
    let file = await resolveFile(target, rel);
    let status = 200;
    if (!file && target.spaFallback && !extname(rel)) file = await resolveFile(target, '');
    if (!file) {
      status = 404;
      file = await resolveFile(target, '404.html');
      if (!file) return plain(res, 404, 'Not Found');
    }
    const info = await stat(file);
    res.statusCode = status;
    res.setHeader('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('content-length', String(info.size));
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) plain(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });
}
