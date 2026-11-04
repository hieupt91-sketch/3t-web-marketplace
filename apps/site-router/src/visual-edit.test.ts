import { createHash } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSiteRouterServer } from './server.ts';

/** Visual editor on the site origin (migration 0046): the router half.
 *  Pins the security shape of the feature: no/invalid/foreign/expired
 *  credentials → the public HTML is byte-identical and nothing is
 *  injected; a valid session → token entry sets an HttpOnly cookie, the
 *  editor is injected, the edit cookie never reaches the site process;
 *  finalize consumes the session, enqueues exactly one apply job with
 *  the exact replacement pairs, and claims the one-time setup right —
 *  or 409s when the form door already claimed it. */
const BASE = 'webmaket.local';
const SITE_ID = 'site-ve-1';
const BUYER_ID = 'buyer-ve-1';
const TASK_ID = 'task-ve-1';
const TOKEN = 've-test-token-0123456789abcdef0123456789';
const TOKEN_HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const CANDIDATES = [
  { id: 'site.name', kind: 'text', vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' },
  { id: 'site.phone', kind: 'text', vi: '0967 136 099' },
  { id: 'hero.image', kind: 'image', url: 'images/hero.jpg' },
];
const PAGE = '<!doctype html><html lang="vi"><body><h1>Phụ Tùng Ô Tô Trường Sơn</h1></body></html>';

interface EditRow {
  id: string; site_id: string; buyer_id: string; task_id: string; token_hash: string;
  candidates_json: unknown; job_id: string | null; expires_at: Date; consumed_at: Date | null;
}
const EDIT_SESSIONS = new Map<string, EditRow>();
const TASKS = new Map<string, { setup_info_json: unknown; setup_info_submitted_at: Date | null }>();
const JOB_ROWS = new Map<string, { status: string; last_error_code: string | null; result_json: unknown }>();
const enqueued: unknown[][] = [];
const audits: unknown[][] = [];

function seedSession(overrides: Partial<EditRow> = {}): EditRow {
  const row: EditRow = {
    id: 'session-ve-1', site_id: SITE_ID, buyer_id: BUYER_ID, task_id: TASK_ID, token_hash: TOKEN_HASH,
    candidates_json: CANDIDATES, job_id: null,
    expires_at: new Date(Date.now() + 2 * 3600_000), consumed_at: null, ...overrides,
  };
  EDIT_SESSIONS.set(row.token_hash, row);
  return row;
}

function fakeDb(): Db {
  return {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO jobs')) {
        enqueued.push(params);
        JOB_ROWS.set('job-ve-1', { status: 'succeeded', last_error_code: null, result_json: { backup_id: 'b1', replacements: 3 } });
        return { rows: [{ id: 'job-ve-1' }] };
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        audits.push(params);
        return { rows: [] };
      }
      if (sql.includes('FROM site_edit_sessions')) {
        const row = EDIT_SESSIONS.get(params[0] as string);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('UPDATE site_edit_sessions SET consumed_at')) {
        const row = [...EDIT_SESSIONS.values()].find((r) => r.id === params[0]);
        if (row && !row.consumed_at && row.expires_at.getTime() > Date.now()) {
          row.consumed_at = new Date();
          return { rows: [{ id: row.id }] };
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE site_edit_sessions SET job_id')) {
        const row = [...EDIT_SESSIONS.values()].find((r) => r.id === params[1]);
        if (row) row.job_id = params[0] as string;
        return { rows: [{ id: params[1] }] };
      }
      if (sql.startsWith('UPDATE service_tasks')) {
        const task = TASKS.get(params[0] as string);
        if (task && !task.setup_info_submitted_at) {
          task.setup_info_json = JSON.parse(params[1] as string);
          task.setup_info_submitted_at = new Date();
          return { rows: [{ id: params[0] }] };
        }
        return { rows: [] };
      }
      if (sql.includes('FROM jobs')) {
        const job = JOB_ROWS.get(params[0] as string);
        return { rows: job ? [job] : [] };
      }
      if (sql.includes('FROM sites')) {
        return { rows: params[0] === 'edit-shop' ? [{ id: SITE_ID, owner_id: BUYER_ID, status: 'active', runtime_port: upstreamPort }] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Db;
}

function call(port: number, host: string, path: string, opts: { method?: string; body?: string; cookie?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectPromise);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let upstream: Server;
let upstreamPort: number;
let router: Server;
let routerPort: number;
const HOST = `edit-shop.${BASE}`;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/echo')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  router = createSiteRouterServer({ config: { siteBaseDomain: BASE, previewBaseDomain: 'preview.localhost' }, db: fakeDb(), cacheMs: 0, restartCooldownMs: 0 });
  await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
  routerPort = (router.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => router.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('public traffic is untouched without a valid edit session', () => {
  it('serves byte-identical HTML with no cookie, a garbage cookie, and a foreign-site cookie', async () => {
    const plain1 = await call(routerPort, HOST, '/');
    expect(plain1.status).toBe(200);
    expect(plain1.body).toBe(PAGE);
    const garbage = await call(routerPort, HOST, '/', { cookie: '__3t_edit=nonsense' });
    expect(garbage.body).toBe(PAGE);
    seedSession({ id: 'session-foreign', site_id: 'another-site', token_hash: createHash('sha256').update('foreign-token', 'utf8').digest('hex') });
    const foreign = await call(routerPort, HOST, '/', { cookie: '__3t_edit=foreign-token' });
    expect(foreign.body).toBe(PAGE);
    expect(plain1.body).not.toContain('__3T_EDIT__');
  });

  it('refuses entry with a garbage or expired token and sets no cookie', async () => {
    const bad = await call(routerPort, HOST, '/__3t_edit/enter?token=nope');
    expect(bad.status).toBe(403);
    expect(bad.headers['set-cookie']).toBeUndefined();
    EDIT_SESSIONS.delete(TOKEN_HASH);
    seedSession({ expires_at: new Date(Date.now() - 60_000) });
    const expired = await call(routerPort, HOST, `/__3t_edit/enter?token=${TOKEN}`);
    expect(expired.status).toBe(403);
    expect(expired.headers['set-cookie']).toBeUndefined();
  });
});

describe('edit mode', () => {
  beforeAll(() => {
    EDIT_SESSIONS.clear();
    TASKS.clear();
    JOB_ROWS.clear();
    enqueued.length = 0;
    audits.length = 0;
    seedSession();
    TASKS.set(TASK_ID, { setup_info_json: null, setup_info_submitted_at: null });
  });

  it('enter with the minted token redirects to / and sets the HttpOnly edit cookie', async () => {
    const res = await call(routerPort, HOST, `/__3t_edit/enter?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = (res.headers['set-cookie'] ?? []).join(';');
    expect(cookie).toContain(`__3t_edit=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
  });

  it('injects the editor bootstrap + script for the session cookie, and strips the cookie upstream', async () => {
    const res = await call(routerPort, HOST, '/', { cookie: `__3t_edit=${TOKEN}; other=1` });
    expect(res.status).toBe(200);
    expect(res.body).toContain('window.__3T_EDIT__=');
    expect(res.body).toContain('/__3t_edit/editor.js');
    expect(res.body).toContain('Phụ Tùng Ô Tô Trường Sơn');
    expect(res.body.indexOf('window.__3T_EDIT__=')).toBeLessThan(res.body.indexOf('</body>'));
    const echo = await call(routerPort, HOST, '/echo', { cookie: `__3t_edit=${TOKEN}; other=1` });
    expect((JSON.parse(echo.body) as { cookie: string | null }).cookie).toBe('other=1');
  });

  it('serves the self-contained editor script', async () => {
    const res = await call(routerPort, HOST, '/__3t_edit/editor.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.body).toContain('__3T_EDIT__');
    expect(res.body.length).toBeGreaterThan(5000);
  });

  it('status reports editing before finalize', async () => {
    const res = await call(routerPort, HOST, '/__3t_edit/status', { cookie: `__3t_edit=${TOKEN}` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ state: 'editing' });
    const anon = await call(routerPort, HOST, '/__3t_edit/status');
    expect(anon.status).toBe(403);
  });

  it('finalize rejects changes outside the candidate set and empty payloads', async () => {
    const unknown = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`,
      body: JSON.stringify({ changes: [{ id: 'site.unknown', vi: 'X' }] }),
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toBe('unknown_candidate');
    const empty = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`, body: JSON.stringify({ changes: [] }),
    });
    expect(empty.status).toBe(400);
    const badImage = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`,
      body: JSON.stringify({ changes: [{ id: 'hero.image', url: 'javascript:alert(1)' }] }),
    });
    expect(badImage.status).toBe(400);
    expect(JSON.parse(badImage.body).error).toBe('invalid_image_url');
    expect(TASKS.get(TASK_ID)?.setup_info_submitted_at).toBeNull();
  });

  it('finalize consumes the session, claims the right, enqueues the exact pairs, and audits', async () => {
    const res = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`,
      body: JSON.stringify({
        changes: [
          { id: 'site.name', vi: 'Phụ Tùng Minh Phát', en: 'Minh Phat Auto Parts' },
          { id: 'hero.image', url: 'https://cdn.example.com/hero-new.jpg' },
        ],
      }),
    });
    expect(res.status, res.body).toBe(202);
    expect(JSON.parse(res.body).job_id).toBe('job-ve-1');

    const task = TASKS.get(TASK_ID)!;
    expect(task.setup_info_submitted_at).toBeTruthy();
    const info = task.setup_info_json as { source: string; session_id: string; business_name?: string; changes: unknown[] };
    expect(info.source).toBe('visual_editor');
    expect(info.session_id).toBe('session-ve-1');
    expect(info.business_name).toBe('Phụ Tùng Minh Phát');
    expect(info.changes.length).toBe(2);

    expect(enqueued.length).toBe(1);
    const [type, dedupe, payload] = enqueued[0] as [string, string, { pairs: { from: string; to: string }[]; task_id: string; session_id: string }];
    expect(type).toBe('site.visual_edit_apply');
    expect(dedupe).toBe('site.visual_edit_apply:session-ve-1');
    expect(payload.task_id).toBe(TASK_ID);
    expect(payload.session_id).toBe('session-ve-1');
    expect(payload.pairs).toEqual([
      { from: 'Phụ Tùng Ô Tô Trường Sơn', to: 'Phụ Tùng Minh Phát' },
      { from: 'Truong Son Auto Parts', to: 'Minh Phat Auto Parts' },
      { from: 'images/hero.jpg', to: 'https://cdn.example.com/hero-new.jpg' },
    ]);
    expect(audits.length).toBe(1);
    expect(audits[0]?.[2]).toBe('site.visual_edit_finalized');

    const session = EDIT_SESSIONS.get(TOKEN_HASH)!;
    expect(session.consumed_at).toBeTruthy();
    expect(session.job_id).toBe('job-ve-1');

    // The public page is clean again for the consumed cookie, and the
    // status now follows the job to done.
    const after = await call(routerPort, HOST, '/', { cookie: `__3t_edit=${TOKEN}` });
    expect(after.body).toBe(PAGE);
    const status = await call(routerPort, HOST, '/__3t_edit/status', { cookie: `__3t_edit=${TOKEN}` });
    expect(JSON.parse(status.body).state).toBe('done');

    const second = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`,
      body: JSON.stringify({ changes: [{ id: 'site.phone', vi: '0900000000' }] }),
    });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).error).toBe('edit_session_consumed');
    expect(enqueued.length).toBe(1);
  });
});

describe('the form door winning the race', () => {
  it('finalize 409s with setup_info.already_submitted when the task is already claimed by the form', async () => {
    EDIT_SESSIONS.clear();
    enqueued.length = 0;
    const row = seedSession({ id: 'session-ve-2' });
    TASKS.set(TASK_ID, { setup_info_json: { business_name: 'Qua Form' }, setup_info_submitted_at: new Date() });
    const res = await call(routerPort, HOST, '/__3t_edit/finalize', {
      method: 'POST', cookie: `__3t_edit=${TOKEN}`,
      body: JSON.stringify({ changes: [{ id: 'site.phone', vi: '0901112223' }] }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toBe('setup_info.already_submitted');
    // The job was still enqueued (the worker will refuse it on the
    // claim check — a visible failure, never a silent file change),
    // and the session is consumed so it cannot be replayed.
    expect(enqueued.length).toBe(1);
    expect(row.consumed_at).toBeTruthy();
    // The form's submission was NOT overwritten.
    expect((TASKS.get(TASK_ID)!.setup_info_json as { business_name: string }).business_name).toBe('Qua Form');
  });
});
