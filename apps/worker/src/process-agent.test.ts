import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type PlatformConfig } from '@3t/core';
import { processAgentMode, probeRunnerHealth, runnerSpawnBody, spawnSiteProcess, stopSiteProcess } from './process-agent.ts';
import { killPid, type SpawnSpec } from './runtime-agent.ts';

/**
 * Sandbox Phase 1 (audit C-01): the worker's process-agent dispatch.
 * Remote mode talks to the site-runner over HTTP with the wire format
 * from sandbox-phase1-impl.md; local mode must keep delegating to the
 * Phase 0 in-process spawner. The runner here is a fake HTTP server
 * that records exactly what the worker sent.
 */

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const openServers: Server[] = [];

async function fakeRunner(handler: (req: RecordedRequest) => { status: number; body: unknown }): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function remoteConfig(url: string, extra: Partial<PlatformConfig> = {}): PlatformConfig {
  return loadConfig({ env: 'test', runtimeAgentUrl: url, runnerToken: 'test-runner-token', ...extra });
}

const runtimeSpec: SpawnSpec = {
  kind: 'runtime',
  dir: '/tmp/site-tree',
  start: ['node', 'server.js'],
  healthPath: '/healthz',
  env: { PUBLIC_FLAG: 'yes' },
  uid: 20001,
  gid: 19990,
  limits: { cpuSeconds: 60, addressSpaceMb: 4096, maxProcesses: 32, fileSizeMb: 128 },
  writableDir: '/tmp/site-tree/data',
};

describe('processAgentMode', () => {
  it('is local without a runner URL and remote with one', () => {
    expect(processAgentMode(loadConfig({ env: 'test' }))).toBe('local');
    expect(processAgentMode(remoteConfig('http://127.0.0.1:4300'))).toBe('remote');
  });
});

describe('remote spawn', () => {
  it('posts the contract body with the token header and maps the reply', async () => {
    const { url, requests } = await fakeRunner(() => ({ status: 200, body: { port: 4321, pid: 999, limitsApplied: true, uidApplied: true } }));
    const config = remoteConfig(url, { siteLimitRssMb: 777 });
    const spawned = await spawnSiteProcess(config, { key: 'site-abc', rowVersion: 3, spec: runtimeSpec });
    expect(spawned).toEqual({ port: 4321, pid: 999, limitsApplied: true, uidApplied: true });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/spawn');
    expect(req.headers['x-runner-token']).toBe('test-runner-token');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.key).toBe('site-abc');
    expect(body.rowVersion).toBe(3);
    expect(body.kind).toBe('runtime');
    expect(body.dir).toBe('/tmp/site-tree');
    expect(body.start).toEqual(['node', 'server.js']);
    expect(body.healthPath).toBe('/healthz');
    expect(body.uid).toBe(20001);
    expect(body.gid).toBe(19990);
    expect(body.writableDir).toBe('/tmp/site-tree/data');
    // prlimit caps ride along, extended with the RSS watchdog cap.
    expect(body.limits).toEqual({ cpuSeconds: 60, addressSpaceMb: 4096, maxProcesses: 32, fileSizeMb: 128, rssMb: 777 });
    // Child env is the buildChildEnv allowlist: no platform values, and
    // no PORT (the runner allocates and sets it).
    const env = body.env as Record<string, string>;
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOST).toBe(config.runtimeBindHost);
    expect(env.PUBLIC_FLAG).toBe('yes');
    expect(env.HOME).toBe('/tmp/site-tree/data');
    expect(env.PORT).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('omits start for static specs and defaults limits from config', () => {
    const config = remoteConfig('http://127.0.0.1:4300');
    const body = runnerSpawnBody(config, {
      key: 'site-static',
      rowVersion: 1,
      spec: { kind: 'static', dir: '/tmp/static-tree', healthPath: '/' },
    });
    expect(body.start).toBeUndefined();
    expect(body.uid).toBeUndefined();
    expect(body.writableDir).toBeUndefined();
    expect(body.limits).toEqual({
      cpuSeconds: config.siteLimitCpuSeconds,
      addressSpaceMb: config.siteLimitAddressSpaceMb,
      maxProcesses: config.siteLimitMaxProcesses,
      fileSizeMb: config.siteLimitFileSizeMb,
      rssMb: 1024,
    });
  });

  it('maps runner errors to Errors carrying the runner error string', async () => {
    const stale = await fakeRunner(() => ({ status: 409, body: { error: 'stale_version' } }));
    await expect(spawnSiteProcess(remoteConfig(stale.url), { key: 'k', rowVersion: 1, spec: runtimeSpec })).rejects.toThrow('stale_version');

    const unhealthy = await fakeRunner(() => ({ status: 502, body: { error: 'health_failed' } }));
    await expect(spawnSiteProcess(remoteConfig(unhealthy.url), { key: 'k', rowVersion: 1, spec: runtimeSpec })).rejects.toThrow('health_failed');

    const denied = await fakeRunner(() => ({ status: 401, body: { error: 'unauthorized' } }));
    await expect(spawnSiteProcess(remoteConfig(denied.url), { key: 'k', rowVersion: 1, spec: runtimeSpec })).rejects.toThrow('unauthorized');
  });

  it('fails closed when the runner is unreachable (no local fallback)', async () => {
    const config = remoteConfig('http://127.0.0.1:1');
    await expect(spawnSiteProcess(config, { key: 'k', rowVersion: 1, spec: runtimeSpec })).rejects.toThrow();
  });
});

describe('remote stop', () => {
  it('posts key + rowVersion only (localPid never crosses the wire)', async () => {
    const { url, requests } = await fakeRunner(() => ({ status: 200, body: { stopped: true } }));
    const result = await stopSiteProcess(remoteConfig(url), { key: 'demo-xyz', rowVersion: 1, localPid: 4242 });
    expect(result).toEqual({ stopped: true });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/stop');
    expect(req.headers['x-runner-token']).toBe('test-runner-token');
    expect(JSON.parse(req.body)).toEqual({ key: 'demo-xyz', rowVersion: 1 });
  });

  it('maps stop errors the same way', async () => {
    const { url } = await fakeRunner(() => ({ status: 401, body: { error: 'unauthorized' } }));
    await expect(stopSiteProcess(remoteConfig(url), { key: 'k', rowVersion: 1 })).rejects.toThrow('unauthorized');
  });
});

describe('probeRunnerHealth', () => {
  it('is true only on a 200 {ok:true} healthz', async () => {
    const ok = await fakeRunner(() => ({ status: 200, body: { ok: true } }));
    await expect(probeRunnerHealth(remoteConfig(ok.url))).resolves.toBe(true);
    const bad = await fakeRunner(() => ({ status: 503, body: { ok: false } }));
    await expect(probeRunnerHealth(remoteConfig(bad.url))).resolves.toBe(false);
    await expect(probeRunnerHealth(remoteConfig('http://127.0.0.1:1'))).resolves.toBe(false);
    await expect(probeRunnerHealth(loadConfig({ env: 'test' }))).resolves.toBe(false);
  });
});

describe('local dispatch', () => {
  it(
    'spawns a real server through spawnServer and stops it by pid',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mp-agent-local-'));
      await writeFile(
        join(dir, 'server.mjs'),
        "import { createServer } from 'node:http';\ncreateServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT), process.env.HOST);\n",
      );
      const config = loadConfig({ env: 'test' });
      const spawned = await spawnSiteProcess(config, {
        key: 'local-test',
        rowVersion: 1,
        spec: { kind: 'runtime', dir, start: [process.execPath, 'server.mjs'], healthPath: '/' },
      });
      try {
        expect(spawned.port).toBeGreaterThan(0);
        expect(spawned.pid).toBeGreaterThan(0);
        const res = await fetch(`http://127.0.0.1:${spawned.port}/`);
        expect(res.status).toBe(200);
        const stopped = await stopSiteProcess(config, { key: 'local-test', rowVersion: 1, localPid: spawned.pid });
        expect(stopped).toEqual({ stopped: true });
        // killPid sends SIGTERM immediately; poll briefly for the exit.
        let alive = true;
        for (let i = 0; i < 20 && alive; i++) {
          alive = await new Promise<boolean>((resolve) => {
            try {
              process.kill(spawned.pid, 0);
              resolve(true);
            } catch {
              resolve(false);
            }
          });
          if (alive) await new Promise((r) => setTimeout(r, 100));
        }
        expect(alive).toBe(false);
      } finally {
        killPid(spawned.pid);
      }
    },
    20_000,
  );
});
