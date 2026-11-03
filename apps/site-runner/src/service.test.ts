import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerService } from './service.js';
import { parseState } from './state.js';
import type { SpawnRequest } from './validate.js';

const FIXTURE_SERVER = `
import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); })
  .listen(Number(process.env.PORT || 0), '127.0.0.1');
`;

let workRoot: string;
let siteDir: string;
const services: RunnerService[] = [];

function makeService(extra: Partial<ConstructorParameters<typeof RunnerService>[0]> = {}): RunnerService {
  const service = new RunnerService({ workRoot, isRoot: () => false, log: () => undefined, ...extra });
  services.push(service);
  return service;
}

function spawnReq(key: string, rssMb: number): SpawnRequest {
  return {
    key,
    rowVersion: 1,
    kind: 'runtime',
    dir: siteDir,
    start: [process.execPath, join(siteDir, 'server.mjs')],
    healthPath: '/',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    uid: 20001,
    gid: 19990,
    limits: { cpuSeconds: 60, addressSpaceMb: 32768, maxProcesses: 1024, fileSizeMb: 64, rssMb },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'runner-service-'));
  siteDir = join(workRoot, 'site-a');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, 'server.mjs'), FIXTURE_SERVER);
});

afterAll(() => {
  for (const service of services) service.shutdown();
  rmSync(workRoot, { recursive: true, force: true });
});

describe('RSS watchdog', () => {
  it(
    'kills a tracked process whose RSS exceeds its spawn cap and logs runner_rss_kill',
    async () => {
      const events: Record<string, unknown>[] = [];
      const service = makeService({ log: (event) => events.push(event) });
      service.boot();
      // rssMb 1 is below any live node's RSS — the service layer trusts the
      // (HTTP-validated) request, so the watchdog path is exercised directly.
      const spawned = await service.spawn(spawnReq('hog-1', 1));
      expect(pidAlive(spawned.pid)).toBe(true);

      service.watchdogTick();

      expect(service.status('hog-1')?.running).toBe(false);
      const kill = events.find((event) => event.event === 'runner_rss_kill');
      expect(kill).toMatchObject({ key: 'hog-1', pid: spawned.pid, rssMb: 1 });
      await waitFor(() => !pidAlive(spawned.pid));
    },
    20000,
  );

  it(
    'leaves a process under its cap alone',
    async () => {
      const service = makeService();
      service.boot();
      const spawned = await service.spawn(spawnReq('calm-1', 8192));
      service.watchdogTick();
      expect(service.status('calm-1')?.running).toBe(true);
      await service.stop({ key: 'calm-1', rowVersion: 1 });
      await waitFor(() => !pidAlive(spawned.pid));
    },
    20000,
  );
});

describe('state persistence and boot adoption', () => {
  it(
    'persists spawns to the state file and a fresh service adopts the live process',
    async () => {
      const first = makeService();
      first.boot();
      const spawned = await first.spawn(spawnReq('adopt-1', 256));

      expect(existsSync(first.stateFile)).toBe(true);
      const persisted = parseState(readFileSync(first.stateFile, 'utf8'));
      expect(persisted.map((entry) => entry.key)).toContain('adopt-1');
      expect(persisted.find((entry) => entry.key === 'adopt-1')).toMatchObject({ pid: spawned.pid, rowVersion: 1, uid: 20001 });

      const second = makeService({
        probePid: () => ({ alive: true, cwd: siteDir, uid: 20001 }),
        listProcesses: () => [],
      });
      const boot = second.boot();
      expect(boot.adopted).toBe(1);
      expect(second.status('adopt-1')).toMatchObject({ running: true, pid: spawned.pid, rowVersion: 1 });

      // The adopting service can stop the process by pid.
      await second.stop({ key: 'adopt-1', rowVersion: 1 });
      await waitFor(() => !pidAlive(spawned.pid));
    },
    20000,
  );

  it('drops recorded entries whose probe disagrees at boot', async () => {
    const writer = makeService();
    writer.boot();
    const spawned = await writer.spawn(spawnReq('stale-1', 256));

    const sceptic = makeService({
      probePid: () => ({ alive: true, cwd: '/somewhere/else', uid: 20001 }),
      listProcesses: () => [],
    });
    const boot = sceptic.boot();
    expect(boot.adopted).toBe(0);
    expect(boot.dropped).toBeGreaterThanOrEqual(1);
    expect(sceptic.status('stale-1')).toBeUndefined();

    await writer.stop({ key: 'stale-1', rowVersion: 1 });
    await waitFor(() => !pidAlive(spawned.pid));
  }, 20000);
});
