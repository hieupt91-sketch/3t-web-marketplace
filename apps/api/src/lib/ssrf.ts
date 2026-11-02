import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * Shared SSRF guard (audit code M-01/M-02). One implementation for every
 * server-side fetch of a user/partner-controlled URL:
 *  - isPublicIp covers the full non-public IPv4 ranges (including the
 *    link-local/metadata range 169.254.0.0/16, CGNAT 100.64.0.0/10,
 *    192.0.0.0/24 and 198.18.0.0/15) and IPv6 loopback/ULA/link-local/
 *    multicast, including IPv4-mapped IPv6 forms.
 *  - resolvePublicAddresses validates EVERY resolved address.
 *  - pinnedRequest connects to one of the validated addresses via a custom
 *    DNS lookup, so the name cannot be re-resolved to a different (private)
 *    address between the check and the fetch (DNS-rebinding TOCTOU).
 */

export class SsrfError extends Error {
  readonly code: 'unresolvable' | 'private_host' | 'invalid_url';
  constructor(code: 'unresolvable' | 'private_host' | 'invalid_url') {
    super(`ssrf.${code}`);
    this.code = code;
  }
}

/** Extract the embedded IPv4 from an IPv4-mapped IPv6 address, if any. */
function mappedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const marker = '::ffff:';
  const idx = lower.indexOf(marker);
  if (idx === -1) return null;
  // Only the compressed mapped form ::ffff:a.b.c.d (or ::ffff:xxxx:xxxx);
  // the fully expanded 0:0:0:0:0:ffff:... form is handled below.
  const tail = lower.slice(idx + marker.length);
  if (isIP(tail) === 4) return tail;
  const hexParts = tail.split(':');
  if (hexParts.length === 2 && hexParts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
    const hi = parseInt(hexParts[0]!, 16);
    const lo = parseInt(hexParts[1]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

function expandedMappedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const suffix = ':ffff:';
  const idx = lower.indexOf(suffix);
  if (idx === -1 || lower.startsWith('::')) return null;
  const head = lower.slice(0, idx).split(':');
  if (head.length !== 5 || head.some((p) => p !== '0')) return null;
  const tail = lower.slice(idx + suffix.length);
  if (isIP(tail) === 4) return tail;
  const hexParts = tail.split(':');
  if (hexParts.length === 2 && hexParts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
    const hi = parseInt(hexParts[0]!, 16);
    const lo = parseInt(hexParts[1]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0]!;
    const b = parts[1]!;
    const c = parts[2]!;
    if (a === 0) return false; // 0.0.0.0/8 "this host on this network"
    if (a === 10) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
    if (a === 127) return false; // loopback
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 168) return false; // private
    if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (version === 6) {
    const mapped = mappedIpv4(ip) ?? expandedMappedIpv4(ip);
    if (mapped) return isPublicIp(mapped);
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return false; // unspecified + loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // fc00::/7 ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false; // fe80::/10 link-local
    if (lower.startsWith('ff')) return false; // ff00::/8 multicast
    return true;
  }
  return false;
}

export function isLoopbackIp(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('127.');
  const mapped = mappedIpv4(ip) ?? expandedMappedIpv4(ip);
  if (mapped) return isLoopbackIp(mapped);
  return ip.toLowerCase() === '::1';
}

/**
 * Resolve a hostname and validate every resulting address. Throws
 * SsrfError('unresolvable') on DNS failure/empty result and
 * SsrfError('private_host') when any address is not public (loopback
 * addresses pass only with allowLoopback).
 */
export async function resolvePublicAddresses(hostname: string, allowLoopback: boolean): Promise<string[]> {
  const host = hostname.toLowerCase();
  if (isIP(host) !== 0) {
    if (isPublicIp(host) || (allowLoopback && isLoopbackIp(host))) return [host];
    throw new SsrfError('private_host');
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfError('unresolvable');
  }
  if (addresses.length === 0) throw new SsrfError('unresolvable');
  for (const { address } of addresses) {
    if (!isPublicIp(address) && !(allowLoopback && isLoopbackIp(address))) {
      throw new SsrfError('private_host');
    }
  }
  return addresses.map((a) => a.address);
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Body text when maxBodyBytes > 0 (truncated at the cap); '' otherwise. */
  body: string;
  /** The validated addresses the connection was pinned to. */
  addresses: string[];
}

/**
 * HTTP(S) request to a URL whose host has been resolved and validated by
 * resolvePublicAddresses; the TCP connection is pinned to the first
 * validated address, while TLS SNI and certificate validation still use
 * the original hostname. Redirects are never followed. DNS is never
 * consulted again after validation, closing the rebinding window.
 */
export async function pinnedRequest(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    allowLoopback?: boolean;
    maxBodyBytes?: number;
  } = {},
): Promise<PinnedResponse> {
  const allowLoopback = options.allowLoopback ?? false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolvePublicAddresses(hostname, allowLoopback);
  const pinned = addresses[0]!;
  const family = isIP(pinned);
  const isHttps = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBodyBytes = options.maxBodyBytes ?? 0;

  return await new Promise<PinnedResponse>((resolve, reject) => {
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        agent: false,
        lookup: ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          cb(null, pinned, family);
        }) as never,
      },
      (res) => {
        let settled = false;
        const finish = (body: string) => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, addresses });
        };
        if (maxBodyBytes === 0) {
          // Status-only callers (connection check): never read the body.
          finish('');
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total <= maxBodyBytes) chunks.push(chunk);
          if (total > maxBodyBytes * 4) {
            finish(Buffer.concat(chunks).toString('utf8'));
            res.destroy();
          }
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        res.on('error', (err) => {
          if (!settled) reject(err);
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('ssrf.timeout'));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
