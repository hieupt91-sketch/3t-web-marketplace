import { request } from 'node:http';

export interface SimpleResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * GET against an internal HTTP endpoint with an explicit Host header. WHATWG fetch treats Host
 * as a forbidden header, so host-routed services (preview origin) are checked with node:http.
 * Redirects are not followed.
 */
export function httpGetWithHost(baseUrl: string, host: string, path: string, timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024): Promise<SimpleResponse> {
  // The path is sent verbatim (no WHATWG normalisation), so security checks see the raw request.
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path, method: 'GET', headers: { host }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
