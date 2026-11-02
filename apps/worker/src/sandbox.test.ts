import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db, PlatformConfig } from '@3t/core';
import { buildLimitedArgv, prlimitArgs, siteLimitsOf, buildChildEnv, type SpawnSpec } from './runtime-agent.ts';
import { allocateSiteUid, fenceSiteTree, sandboxStatus, siteUidForSlot } from './sandbox.ts';

/**
 * Sandbox Phase 0 (audit C-01): the UID fence is what closes the /proc
 * environ leak and the cross-tenant data read. These tests lock the
 * mechanics: pool allocation, prlimit argv, the child env allowlist, and
 * the on-disk fencing shape.
 */

function stubConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    sandboxUidMode: 'auto',
    siteUidBase: 20000,
    siteUidPoolSize: 3,
    siteGid: 19990,
    demoUid: 19998,
    importUid: 19999,
    siteLimitCpuSeconds: 86400,
    siteLimitAddressSpaceMb: 1024,
    siteLimitMaxProcesses: 256,
    siteLimitFileSizeMb: 1024,
    runtimeBindHost: '127.0.0.1',
    demoSpawnWaitMs: 30000,
    ...overrides,
  } as PlatformConfig;
}

describe('sandboxStatus', () => {
  it('is disabled by explicit off regardless of euid', () => {
    expect(sandboxStatus(stubConfig({ sandboxUidMode: 'off' })).enabled).toBe(false);
  });

  it('follows euid in auto mode', () => {
    const status = sandboxStatus(stubConfig());
    expect(status.enabled).toBe((process.getuid?.() ?? -1) === 0);
  });
});

describe('site UID pool', () => {
  it('maps slots onto the configured base', () => {
    const config = stubConfig();
    expect(siteUidForSlot(config, 0)).toBe(20000);
    expect(siteUidForSlot(config, 2)).toBe(20002);
  });

  /** Minimal in-memory stand-in for the three queries allocateSiteUid issues. */
  function fakeDb(initial: Map<string, number | null>, failFirstUpdateWith23505 = false) {
    const rows = new Map(initial);
    let failed = false;
    return {
      rows,
      async query(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT runtime_uid FROM sites WHERE id')) {
          const uid = rows.get(params[0] as string) ?? null;
          return { rows: [{ runtime_uid: uid }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT runtime_uid FROM sites WHERE runtime_uid')) {
          return { rows: [...rows.values()].filter((u) => u !== null).map((u) => ({ runtime_uid: u as number })), rowCount: 0 };
        }
        if (sql.startsWith('UPDATE sites SET runtime_uid')) {
          if (failFirstUpdateWith23505 && !failed) {
            failed = true;
            const error = new Error('duplicate key') as Error & { code: string };
            error.code = '23505';
            throw error;
          }
          const [siteId, uid] = params as [string, number];
          if (rows.get(siteId) !== null && rows.get(siteId) !== undefined) return { rows: [], rowCount: 0 };
          if ([...rows.values()].includes(uid)) {
            const error = new Error('duplicate key') as Error & { code: string };
            error.code = '23505';
            throw error;
          }
          rows.set(siteId, uid);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Db;
  }

  it('allocates the lowest free slot and records it', async () => {
    const db = fakeDb(new Map([['site-a', 20000], ['site-b', null]]));
    const uid = await allocateSiteUid(db, stubConfig(), 'site-b');
    expect(uid).toBe(20001);
  });

  it('returns the recorded allocation on later spawns', async () => {
    const db = fakeDb(new Map([['site-a', 20002]]));
    await expect(allocateSiteUid(db, stubConfig(), 'site-a')).resolves.toBe(20002);
  });

  it('retries on a unique-violation race and takes the next slot', async () => {
    const db = fakeDb(new Map([['site-b', null]]), true);
    await expect(allocateSiteUid(db, stubConfig(), 'site-b')).resolves.toBe(20000);
  });

  it('refuses when the pool is exhausted instead of double-allocating', async () => {
    const db = fakeDb(new Map([['a', 20000], ['b', 20001], ['c', 20002], ['d', null]]));
    await expect(allocateSiteUid(db, stubConfig(), 'd')).rejects.toThrow(/pool exhausted/);
  });

  it('allocates nothing when fencing is off', async () => {
    const db = fakeDb(new Map([['site-a', null]]));
    await expect(allocateSiteUid(db, stubConfig({ sandboxUidMode: 'off' }), 'site-a')).resolves.toBeNull();
  });
});

describe('prlimit wrapping', () => {
  it('builds the executor-style caps in bytes where prlimit counts bytes', () => {
    const config = stubConfig();
    expect(prlimitArgs(siteLimitsOf(config))).toEqual([
      '--cpu=86400',
      '--as=1073741824',
      '--nproc=256',
      '--fsize=1073741824',
    ]);
  });

  it('wraps argv with prlimit first so the recorded pid is the server pid', () => {
    const wrapped = buildLimitedArgv(['node', 'server.mjs'], siteLimitsOf(stubConfig()), true);
    expect(wrapped.applied).toBe(true);
    expect(wrapped.argv[0]).toBe('/usr/bin/prlimit');
    expect(wrapped.argv.slice(-3)).toEqual(['--', 'node', 'server.mjs']);
  });

  it('passes argv through untouched when prlimit is unavailable', () => {
    const wrapped = buildLimitedArgv(['node', 'server.mjs'], siteLimitsOf(stubConfig()), false);
    expect(wrapped).toEqual({ argv: ['node', 'server.mjs'], applied: false });
  });
});

describe('child env allowlist (regression lock for C-01)', () => {
  const SENTINELS = ['DATABASE_URL', 'MFA_KEY', 'PARTNER_WEBHOOK_KEY', 'MOCK_PAYMENT_SECRET'];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of SENTINELS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('never leaks platform secrets from the worker env into a site child', () => {
    for (const key of SENTINELS) {
      saved.set(key, process.env[key]);
      process.env[key] = 'sentinel-secret';
    }
    const spec: SpawnSpec = {
      kind: 'runtime',
      dir: '/tmp/site',
      start: ['node', 'server.mjs'],
      healthPath: '/',
      env: { PUBLIC_FLAG: 'yes' },
      writableDir: '/tmp/site/data',
    };
    const env = buildChildEnv(stubConfig(), spec, 4321);
    for (const key of SENTINELS) expect(env[key]).toBeUndefined();
    expect(Object.values(env)).not.toContain('sentinel-secret');
    expect(env.PORT).toBe('4321');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PUBLIC_FLAG).toBe('yes');
    expect(env.HOME).toBe('/tmp/site/data');
    expect(env.TMPDIR).toBe('/tmp/site/data/.tmp');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HOST', 'NODE_ENV', 'PATH', 'PORT', 'PUBLIC_FLAG', 'TMPDIR']);
  });
});

const asRoot = (process.getuid?.() ?? -1) === 0;
describe.runIf(asRoot)('fenceSiteTree (root)', () => {
  it('fences root/data/code to the site UID shape', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-fence-'));
    const dir = join(base, 'site');
    await mkdir(join(dir, 'data', 'uploads'), { recursive: true });
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'server.mjs'), 'export {};');
    await writeFile(join(dir, 'assets', 'a.txt'), 'code');
    await writeFile(join(dir, 'data', 'content.json'), '{"mine":true}');
    await writeFile(join(dir, 'data', 'uploads', 'u.txt'), 'upload');
    // Simulate store-extracted permissive modes the fence must tighten.
    await chmod(join(dir, 'server.mjs'), 0o666);
    await chmod(join(dir, 'data', 'content.json'), 0o644);

    const fenced = await fenceSiteTree(stubConfig(), dir, 20077);
    expect(fenced).toBe(true);

    const root = await lstat(dir);
    expect(root.uid).toBe(20077);
    expect(root.mode & 0o7777).toBe(0o1700);
    const data = await lstat(join(dir, 'data'));
    expect(data.uid).toBe(20077);
    expect(data.mode & 0o777).toBe(0o700);
    const content = await lstat(join(dir, 'data', 'content.json'));
    expect(content.uid).toBe(20077);
    expect(content.mode & 0o777).toBe(0o600);
    const code = await lstat(join(dir, 'server.mjs'));
    expect(code.uid).toBe(0);
    expect(code.mode & 0o022).toBe(0);
    expect(code.mode & 0o004).toBe(0o004);
    // Ancestors up to the workDir boundary become traversable (o+x only),
    // so the fenced child can actually reach its own tree under any umask.
    const parent = await lstat(base);
    expect(parent.mode & 0o001).toBe(0o001);
  });

  it('is a no-op when fencing is disabled', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-fence-off-'));
    const dir = join(base, 'site');
    await mkdir(join(dir, 'data'), { recursive: true });
    const before = await lstat(dir);
    const fenced = await fenceSiteTree(stubConfig({ sandboxUidMode: 'off' }), dir, 20077);
    expect(fenced).toBe(false);
    expect((await lstat(dir)).uid).toBe(before.uid);
  });
});
