import { createHmac, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from './secret-store.ts';

/** Webhook secrets use the shared encrypted-secret envelope (see secret-store). */
export const encryptWebhookSecret = encryptSecret;
export const decryptWebhookSecret = decryptSecret;
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Partner webhook delivery (docs/06 §9).
 * SSRF/DNS-rebinding guard (AT-43): HTTPS only, no private/loopback/link-local/
 * reserved IPs, and the hostname is re-resolved at send time — a redirect to
 * another host is never followed (redirect: 'manual').
 * Loopback is allowed only when explicitly enabled (dev/test).
 */
export async function assertPublicWebhookUrl(rawUrl: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('webhook.invalid_url');
  }
  if (!url.hostname) throw new Error('webhook.invalid_url');
  const host = url.hostname.toLowerCase();
  const isLoopbackHost = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  // Dev/test loopback may use plain HTTP (no TLS on localhost); public hosts must use HTTPS.
  if (url.protocol !== 'https:' && !(allowLoopback && isLoopbackHost)) throw new Error('webhook.https_required');
  if ((host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) && !allowLoopback) {
    throw new Error('webhook.private_host');
  }
  const ipVersion = isIP(host);
  if (ipVersion !== 0) {
    if (!isPublicIp(host) && !(allowLoopback && (host === '127.0.0.1' || host === '::1'))) {
      throw new Error('webhook.private_host');
    }
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('webhook.unresolvable');
  }
  for (const { address } of addresses) {
    if (!isPublicIp(address) && !(allowLoopback && (address === '127.0.0.1' || address === '::1'))) {
      throw new Error('webhook.private_host');
    }
  }
  return url;
}

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 0 || a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return false;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false;
    if (lower.startsWith('ff')) return false;
    return true;
  }
  return false;
}

export function signWebhookBody(secret: string, timestampSeconds: number, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')}`;
}

/** Verify a receiver-side signature (AT-42): constant-time, 5-minute skew. */
export function verifyWebhookSignature(secret: string, timestampHeader: string, signatureHeader: string, rawBody: string): boolean {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = signWebhookBody(secret, ts, rawBody);
  if (signatureHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

export const WEBHOOK_RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 720, 1440];

export interface PartnerEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Record a partner event as deliveries for every verified endpoint subscribed
 * to that type. Delivery attempts are made by the send endpoint (admin/partner
 * test action), not inline, so a slow receiver never blocks the request path.
 * Production should run a delivery worker over pending rows with the same
 * sendWebhookDelivery function; that worker is the documented next step.
 */
export async function emitPartnerEvent(
  client: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  partnerId: string,
  event: PartnerEvent,
): Promise<void> {
  const eventId = `evt_${crypto.randomUUID()}`;
  const payload = {
    id: eventId,
    type: event.type,
    created_at: new Date().toISOString(),
    api_version: 'v1',
    data: event.data,
  };
  const endpoints = await client.query<{ id: string; events: string[] }>(
    `SELECT id, events FROM webhook_endpoints WHERE partner_id = $1 AND status = 'verified'`,
    [partnerId],
  );
  for (const endpoint of endpoints.rows) {
    if (!endpoint.events.includes(event.type)) continue;
    await client.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload_json, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, now()) ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [endpoint.id, eventId, event.type, JSON.stringify(payload)],
    );
  }
}

/** One signed delivery attempt; updates the row to delivered/failed/dead. */
export async function sendWebhookDelivery(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  deliveryId: string,
  endpointUrl: string,
  endpointSecret: string,
  allowLoopback: boolean,
): Promise<'delivered' | 'failed' | 'dead'> {
  const row = await db.query<{ payload_json: unknown; attempts: number }>(
    'SELECT payload_json, attempts FROM webhook_deliveries WHERE id = $1',
    [deliveryId],
  );
  const delivery = row.rows[0];
  if (!delivery) return 'dead';
  const rawBody = JSON.stringify(delivery.payload_json);
  let outcome: 'delivered' | 'failed' | 'dead' = 'failed';
  let responseStatus: number | null = null;
  try {
    const url = await assertPublicWebhookUrl(endpointUrl, allowLoopback);
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-3t-event-id': (delivery.payload_json as { id: string }).id,
        'x-3t-timestamp': String(timestamp),
        'x-3t-signature': signWebhookBody(endpointSecret, timestamp, rawBody),
      },
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    responseStatus = res.status;
    await res.text().catch(() => '');
    outcome = res.status >= 200 && res.status < 300 ? 'delivered' : 'failed';
  } catch {
    outcome = 'failed';
  }
  const attempts = delivery.attempts + 1;
  if (outcome === 'delivered') {
    await db.query('UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4 WHERE id = $1', [deliveryId, 'delivered', attempts, responseStatus]);
    return 'delivered';
  }
  const delay = WEBHOOK_RETRY_DELAYS_MINUTES[attempts - 1];
  if (delay === undefined) {
    await db.query('UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4 WHERE id = $1', [deliveryId, 'dead', attempts, responseStatus]);
    return 'dead';
  }
  await db.query('UPDATE webhook_deliveries SET status = $2, attempts = $3, response_status = $4, next_attempt_at = now() + make_interval(mins => $5) WHERE id = $1', [deliveryId, 'failed', attempts, responseStatus, delay]);
  return 'failed';
}
