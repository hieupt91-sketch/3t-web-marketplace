/**
 * Hand-rolled node:http transport for the runner API (impl contract
 * §"Runner HTTP API"). Node builtins only — the runner must not load
 * platform config or any framework. Every /v1 call requires the
 * x-runner-token header, compared in constant time (hash-then-compare, so
 * neither content nor length leaks through timing).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HealthFailedError, RunnerService, StaleVersionError, type LogFn } from './service.js';
import { validateKey, validateSpawnBody, validateStopBody } from './validate.js';

export const MAX_BODY_BYTES = 64 * 1024;

export function tokenMatches(presented: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (!value || !expected) return false;
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : 'http_error');
    this.name = 'HttpError';
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue; // drain without buffering so the client can finish sending
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new HttpError(413, { error: 'too_large' });
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(422, { error: 'invalid', details: 'request body must be valid JSON' });
  }
}

export interface RunnerServerOptions {
  token: string;
  workRoot: string;
  siteGid: number;
  /** Defaults to the serving process's execPath. */
  execPath?: string;
  log?: LogFn;
}

export function createRunnerServer(service: RunnerService, opts: RunnerServerOptions): Server {
  const execPath = opts.execPath ?? process.execPath;
  const log: LogFn = opts.log ?? ((event) => console.log(JSON.stringify(event)));

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://site-runner.local');

        if (req.method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url.pathname.startsWith('/v1/')) {
          if (!tokenMatches(req.headers['x-runner-token'], opts.token)) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/spawn') {
            const body = await readJsonBody(req);
            const validation = validateSpawnBody(body, { workRoot: opts.workRoot, siteGid: opts.siteGid, execPath });
            if (!validation.ok) {
              sendJson(res, 422, { error: 'invalid', details: validation.details });
              return;
            }
            try {
              const result = await service.spawn(validation.value);
              sendJson(res, 200, { ...result });
            } catch (error) {
              if (error instanceof StaleVersionError) sendJson(res, 409, { error: 'stale_version' });
              else if (error instanceof HealthFailedError) sendJson(res, 502, { error: 'health_failed' });
              else throw error;
            }
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/stop') {
            const body = await readJsonBody(req);
            const validation = validateStopBody(body);
            if (!validation.ok) {
              sendJson(res, 422, { error: 'invalid', details: validation.details });
              return;
            }
            const result = await service.stop(validation.value);
            sendJson(res, 200, { ...result });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/status') {
            const key = validateKey(url.searchParams.get('key'));
            if (key === null) {
              sendJson(res, 422, { error: 'invalid', details: 'key query parameter is missing or malformed' });
              return;
            }
            const status = service.status(key);
            if (!status) {
              sendJson(res, 404, { error: 'not_found' });
              return;
            }
            sendJson(res, 200, { ...status });
            return;
          }

          sendJson(res, 404, { error: 'not_found' });
          return;
        }

        sendJson(res, 404, { error: 'not_found' });
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, error.body);
          return;
        }
        log({ event: 'runner_http_error', error: error instanceof Error ? error.message : String(error) });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        else res.end();
      }
    })();
  });
}
