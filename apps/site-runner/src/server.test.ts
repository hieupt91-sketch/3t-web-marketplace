import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerService } from './service.js';
import { createRunnerServer } from './server.js';

const TOKEN = 'test-token';
const FIXTURE_SERVER = `
import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); })
  .listen(Number(process.env.PORT || 0), '127.0.0.1');
`;

let workRoot: string;
let siteDir: string;
let failDir: string;
let service: RunnerService;
let server: Server;
let base: string;
const spawnedPids: number[] = [];

function spawnBody(key: string, rowVersion: number, dir: string = siteDir): Record<string, unknown> {
  return {
    key,
    rowVersion,
    kind: 'runtime',
    dir,
    start: [process.execPath, join(dir, 'server.mjs')],
    healthPath: '/',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    uid: 20001,
    gid: 19990,
    limits: { cpuSeconds: 60, addressSpaceMb: 32768, maxProcesses: 1024, fileSizeMb: 64, rssMb: 256 },
  };
}

async function call(
  method: string,
  path: string,
  payload?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers['x-runner-token'] = token;
  let body: string | undefined;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'runner-http-'));
  siteDir = join(workRoot, 'site-a');
  failDir = join(workRoot, 'site-fail');
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(failDir, { recursive: true });
  writeFileSync(join(siteDir, 'server.mjs'), FIXTURE_SERVER);
  writeFileSync(join(failDir, 'server.mjs'), 'process.exit(1);\n');
  // Non-root run (dev/show-env posture): the runner must not apply the uid.
  service = new RunnerService({ workRoot, isRoot: () => false, log: () => undefined });
  service.boot();
  server = createRunnerServer(service, { token: TOKEN, workRoot, siteGid: 19990 });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  service.shutdown();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(workRoot, { recursive: true, force: true });
});

describe('auth', () => {
  it('serves /healthz without auth', async () => {
    const res = await call('GET', '/healthz', undefined, null);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects missing and wrong tokens with 401 on every /v1 route', async () => {
    for (const token of [null, 'wrong-token']) {
      const spawn = await call('POST', '/v1/spawn', spawnBody('auth-1', 1), token);
      expect(spawn.status).toBe(401);
      expect(spawn.body.error).toBe('unauthorized');
      const stop = await call('POST', '/v1/stop', { key: 'auth-1', rowVersion: 1 }, token);
      expect(stop.status).toBe(401);
      const status = await call('GET', '/v1/status?key=auth-1', undefined, token);
      expect(status.status).toBe(401);
    }
  });

  it('accepts the right token', async () => {
    const res = await call('GET', '/v1/status?key=auth-1');
    expect(res.status).toBe(404); // authed, just unknown
  });
});

describe('validation over HTTP', () => {
  it('rejects a dir escape with 422 invalid', async () => {
    const res = await call('POST', '/v1/spawn', spawnBody('esc-1', 1, tmpdir()));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid');
  });

  it('rejects an out-of-pool uid with 422', async () => {
    const res = await call('POST', '/v1/spawn', { ...spawnBody('uid-1', 1), uid: 12345 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid');
  });

  it('rejects a body over 64 KB with 413', async () => {
    const big = JSON.stringify({ ...spawnBody('big-1', 1), env: { PATH: 'x'.repeat(70000) } });
    expect(big.length).toBeGreaterThan(64 * 1024);
    const res = await call('POST', '/v1/spawn', big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_large');
  });

  it('rejects malformed JSON with 422', async () => {
    const res = await call('POST', '/v1/spawn', '{not json');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid');
  });

  it('404s unknown keys and unknown routes', async () => {
    expect((await call('GET', '/v1/status?key=never-seen')).status).toBe(404);
    expect((await call('GET', '/v1/nope')).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});

describe('lifecycle', () => {
  it(
    'spawn → status → fencing → stop',
    async () => {
      const spawned = await call('POST', '/v1/spawn', spawnBody('fence-1', 2));
      expect(spawned.status).toBe(200);
      const pid = spawned.body.pid as number;
      expect(pid).toBeGreaterThan(0);
      spawnedPids.push(pid);
      expect(spawned.body.port as number).toBeGreaterThan(0);
      // Non-root runner: uid requested but not applied, honestly reported.
      expect(spawned.body.uidApplied).toBe(false);
      expect(typeof spawned.body.limitsApplied).toBe('boolean');
      expect(pidAlive(pid)).toBe(true);

      const status = await call('GET', '/v1/status?key=fence-1');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ running: true, pid, rowVersion: 2 });

      // Same or lower version cannot replace a live process.
      expect((await call('POST', '/v1/spawn', spawnBody('fence-1', 2))).status).toBe(409);
      const staleSpawn = await call('POST', '/v1/spawn', spawnBody('fence-1', 1));
      expect(staleSpawn.status).toBe(409);
      expect(staleSpawn.body.error).toBe('stale_version');

      // A stop carrying an older version must not kill the newer spawn.
      const staleStop = await call('POST', '/v1/stop', { key: 'fence-1', rowVersion: 1 });
      expect(staleStop.status).toBe(200);
      expect(staleStop.body.stopped).toBe(false);
      expect((await call('GET', '/v1/status?key=fence-1')).body.running).toBe(true);
      expect(pidAlive(pid)).toBe(true);

      // A stop at the stored version works and untracks the key.
      const stopped = await call('POST', '/v1/stop', { key: 'fence-1', rowVersion: 2 });
      expect(stopped.body.stopped).toBe(true);
      expect((await call('GET', '/v1/status?key=fence-1')).status).toBe(404);
      await waitFor(() => !pidAlive(pid));

      // Unknown-key stop is a no-op, still 200.
      const unknownStop = await call('POST', '/v1/stop', { key: 'fence-1', rowVersion: 2 });
      expect(unknownStop.status).toBe(200);
      expect(unknownStop.body.stopped).toBe(false);
    },
    20000,
  );

  it(
    'replaces a dead process at the same version',
    async () => {
      const first = await call('POST', '/v1/spawn', spawnBody('replace-1', 1));
      expect(first.status).toBe(200);
      const pid1 = first.body.pid as number;
      spawnedPids.push(pid1);

      process.kill(pid1, 'SIGKILL');
      await waitFor(async () => (await call('GET', '/v1/status?key=replace-1')).body.running === false);

      const second = await call('POST', '/v1/spawn', spawnBody('replace-1', 1));
      expect(second.status).toBe(200);
      const pid2 = second.body.pid as number;
      spawnedPids.push(pid2);
      expect(pid2).not.toBe(pid1);

      // ...but an older version still cannot replace even a dead entry.
      process.kill(pid2, 'SIGKILL');
      await waitFor(async () => (await call('GET', '/v1/status?key=replace-1')).body.running === false);
      const tooOld = await call('POST', '/v1/spawn', spawnBody('replace-1', 0));
      expect(tooOld.status).toBe(422); // rowVersion 0 fails validation first

      const stopped = await call('POST', '/v1/stop', { key: 'replace-1', rowVersion: 1 });
      expect(stopped.body.stopped).toBe(true);
    },
    20000,
  );

  it(
    'maps a health failure to 502 and tracks nothing',
    async () => {
      const res = await call('POST', '/v1/spawn', spawnBody('healthfail-1', 1, failDir));
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('health_failed');
      expect((await call('GET', '/v1/status?key=healthfail-1')).status).toBe(404);
    },
    20000,
  );
});
