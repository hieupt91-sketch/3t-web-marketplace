import { createHash } from 'node:crypto';
import { lookup, resolveCname, resolveTxt } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { safeEqualHex } from './crypto.ts';

/* ------------------------------------------------------------------ *
 * Custom-domain verification primitives, shared by the API verify
 * route and the worker revalidation sweep (audit payments L6 follow-up).
 *
 * A custom domain is only truly connected when BOTH hold:
 *  - ownership: DNS TXT `_3t-verify.<host>` carries a token whose
 *    sha256 hex equals domains.verification_token_hash;
 *  - routing: traffic for the hostname actually arrives at the site
 *    router — proven either by the CNAME chain reaching the platform
 *    routing target (config.customDomainTarget) or by the router
 *    answering its probe path on that hostname (which also covers
 *    apex CNAME-flattening/ALIAS setups and proxied chains, where no
 *    CNAME is visible at the hostname itself).
 *
 * Every resolver/probe is injectable so tests never touch real DNS —
 * the same seam style as the worker sweep's TxtResolver option.
 * ------------------------------------------------------------------ */

export type TxtResolver = (name: string) => Promise<string[][]>;
export type CnameResolver = (name: string) => Promise<string[]>;

/** 'ok' — the router answered with the exact probe marker.
 *  'wrong' — something answered HTTP on the hostname, but it was not
 *  the router (traffic lands elsewhere: a conclusive routing failure).
 *  'unreachable' — nothing conclusive: DNS failure, refused, timeout. */
export type RoutingProbeResult = 'ok' | 'wrong' | 'unreachable';
export type RoutingProbe = (hostname: string) => Promise<RoutingProbeResult>;

export interface DomainDnsDeps {
  resolveTxt?: TxtResolver;
  resolveCname?: CnameResolver;
  probe?: RoutingProbe;
}

export const ROUTER_PROBE_PATH = '/__3t_probe';
export const ROUTER_PROBE_BODY = '3t-router-ok';
export const ROUTER_PROBE_TIMEOUT_MS = 4000;

export function normalizeHostname(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/** A presented TXT value matches when its sha256 hex equals the stored hash. */
export function domainTxtValueMatches(value: string, tokenHash: string): boolean {
  return safeEqualHex(createHash('sha256').update(value).digest('hex'), tokenHash);
}

/** Flattened TXT chunks (the API/worker comparison rule since C08/L6). */
export function domainTxtRecordsMatch(records: string[][], tokenHash: string): boolean {
  return records.flat().some((value) => domainTxtValueMatches(value, tokenHash));
}

/** Ownership check for the API verify route: any resolver error = not proven. */
export async function checkDomainOwnership(hostname: string, tokenHash: string, resolver?: TxtResolver): Promise<boolean> {
  const resolve = resolver ?? ((name: string) => resolveTxt(name));
  try {
    return domainTxtRecordsMatch(await resolve(`_3t-verify.${normalizeHostname(hostname)}`), tokenHash);
  } catch {
    return false;
  }
}

export interface CnameChainResult {
  reached: boolean;
  /** True when DNS answered conclusively (records found, or the name/record
   *  definitively does not exist). False on transient resolver weather. */
  conclusive: boolean;
}

const DEFINITIVE_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND']);

/** Follow the CNAME chain from `hostname` (up to maxHops hops) looking for `target`. */
export async function checkCnameChain(
  hostname: string,
  target: string,
  resolver?: CnameResolver,
  maxHops = 5,
): Promise<CnameChainResult> {
  const resolve = resolver ?? ((name: string) => resolveCname(name));
  const wanted = normalizeHostname(target);
  let current = normalizeHostname(hostname);
  for (let hop = 0; hop < maxHops; hop++) {
    let records: string[];
    try {
      records = await resolve(current);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      // ENODATA/ENOTFOUND end the chain conclusively; anything else is weather.
      return { reached: false, conclusive: DEFINITIVE_DNS_CODES.has(code) };
    }
    if (records.length === 0) return { reached: false, conclusive: true };
    const normalized = records.map(normalizeHostname);
    if (normalized.includes(wanted)) return { reached: true, conclusive: true };
    current = normalized[0]!;
  }
  // Hop budget exhausted mid-chain — nothing conclusive either way.
  return { reached: false, conclusive: false };
}

/* ------------------------- routing probe ------------------------- */

/** Non-public IPv4 ranges (mirrors the API SSRF guard's coverage). */
function ipv4IsPublic(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // "this" net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 + TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3 203.0.113.0/24
  if (a >= 224) return false; // multicast + reserved
  return true;
}

/**
 * The expanded (uncompressed) IPv4-mapped form, 0:0:0:0:0:ffff:a.b.c.d or
 * 0:0:0:0:0:ffff:xxxx:xxxx — the same shape apps/api's SSRF guard unwraps.
 * Returns the embedded IPv4 address, or null when `ip` is not that form.
 */
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

function ipv6IsPublic(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return false;
  const expandedMapped = expandedMappedIpv4(ip);
  if (expandedMapped) return ipv4IsPublic(expandedMapped);
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length);
    if (isIP(tail) === 4) return ipv4IsPublic(tail);
    const hex = tail.split(':');
    if (hex.length === 2 && hex.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const hi = parseInt(hex[0]!, 16);
      const lo = parseInt(hex[1]!, 16);
      return ipv4IsPublic(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return false;
  }
  if (/^fe[89ab]/.test(lower)) return false; // link-local fe80::/10
  if (/^f[cd]/.test(lower)) return false; // ULA fc00::/7
  if (lower.startsWith('ff')) return false; // multicast
  if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return false; // documentation
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family === 6) return ipv6IsPublic(address);
  return false;
}

export interface RoutingProbeDeps {
  /** Injectable for tests; defaults to dns.lookup with all addresses. */
  lookupAll?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /** Injectable for tests; defaults to a single pinned HTTP GET. */
  httpGet?: (address: string, hostname: string, timeoutMs: number) => Promise<{ status: number; body: string }>;
  timeoutMs?: number;
}

function pinnedHttpGet(address: string, hostname: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = <T,>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const req = httpRequest(
      { host: address, port: 80, path: ROUTER_PROBE_PATH, method: 'GET', headers: { host: hostname }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1024) chunks.push(chunk);
        });
        res.on('end', () => settle(resolvePromise, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    // Hard deadline on top of the socket timeout: the `timeout` option
    // only bounds socket INACTIVITY, so a peer that drips bytes forever
    // (or streams an endless body) would hold the probe open. This timer
    // destroys the request at timeoutMs regardless of socket activity.
    const deadline = setTimeout(() => req.destroy(new Error('probe timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', (error) => settle(rejectPromise, error));
    req.end();
  });
}

/**
 * Ask the site router, through the hostname's own DNS, whether traffic
 * arrives: resolve the hostname, refuse the whole answer if ANY address
 * is non-public (the probe must never become an SSRF hop into the
 * platform's own network), then pinned GETs of the probe path against
 * the validated addresses, in order, until one proves the router.
 */
export async function probeDomainRouting(hostname: string, deps: RoutingProbeDeps = {}): Promise<RoutingProbeResult> {
  const host = normalizeHostname(hostname);
  const timeoutMs = deps.timeoutMs ?? ROUTER_PROBE_TIMEOUT_MS;
  const lookupAll = deps.lookupAll ?? (async (name: string) => lookup(name, { all: true, verbatim: true }));
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupAll(host);
  } catch {
    return 'unreachable';
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) return 'unreachable';
  const httpGet = deps.httpGet ?? pinnedHttpGet;
  // Any 'ok' wins: multi-homed/anycast answers can legitimately differ
  // per address, so a non-router answer (or a dead transport) on one
  // address is only conclusive when no other address proves the router.
  let answeredWrong = false;
  for (const candidate of addresses) {
    try {
      const res = await httpGet(candidate.address, host, timeoutMs);
      if (res.status === 200 && res.body === ROUTER_PROBE_BODY) return 'ok';
      answeredWrong = true;
    } catch {
      // Transport failure on this address says nothing about the others.
    }
  }
  return answeredWrong ? 'wrong' : 'unreachable';
}

export const defaultRoutingProbe: RoutingProbe = (hostname) => probeDomainRouting(hostname);

export interface RoutingCheckResult {
  ok: boolean;
  /** True when the outcome is safe to act on (start a failure grace, mark
   *  routing failed for the buyer). False = DNS weather; retry later. */
  conclusive: boolean;
}

/**
 * Combined routing verdict: the CNAME chain reaching the target is proof;
 * otherwise the router probe decides — including for apex flattening and
 * proxied setups the chain cannot see.
 */
export async function checkDomainRouting(hostname: string, target: string, deps: DomainDnsDeps = {}): Promise<RoutingCheckResult> {
  const chain = await checkCnameChain(hostname, target, deps.resolveCname);
  if (chain.reached) return { ok: true, conclusive: true };
  const probe = deps.probe ?? defaultRoutingProbe;
  let result: RoutingProbeResult;
  try {
    result = await probe(normalizeHostname(hostname));
  } catch {
    result = 'unreachable';
  }
  if (result === 'ok') return { ok: true, conclusive: true };
  if (result === 'wrong') return { ok: false, conclusive: true };
  // Nothing answered: conclusive only when the DNS chain itself was
  // conclusive (name exists but does not route here, or does not exist).
  return { ok: false, conclusive: chain.conclusive };
}
