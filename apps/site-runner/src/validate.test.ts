import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isWithinRoot,
  siteUidList,
  validateSpawnBody,
  validateStopBody,
  type SpawnRequest,
  type ValidateContext,
} from './validate.js';

let workRoot: string;
let outsideDir: string;
let siteDir: string;
let ctx: ValidateContext;

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'site-abc123',
    rowVersion: 1,
    kind: 'runtime',
    dir: siteDir,
    start: [process.execPath, join(siteDir, 'server.mjs')],
    healthPath: '/',
    env: { PATH: '/usr/bin:/bin' },
    uid: 20001,
    gid: 19990,
    limits: { cpuSeconds: 60, addressSpaceMb: 32768, maxProcesses: 1024, fileSizeMb: 64, rssMb: 256 },
    ...overrides,
  };
}

function bad(body: unknown): string {
  const result = validateSpawnBody(body, ctx);
  if (result.ok) throw new Error('expected validation to fail');
  return result.details;
}

function good(body: unknown): SpawnRequest {
  const result = validateSpawnBody(body, ctx);
  if (!result.ok) throw new Error(`expected valid, got: ${result.details}`);
  return result.value;
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'runner-validate-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'runner-outside-'));
  siteDir = join(workRoot, 'site-a');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(workRoot, 'a-file.txt'), 'not a dir');
  ctx = { workRoot, siteGid: 19990, execPath: process.execPath };
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('validateSpawnBody — happy path', () => {
  it('accepts a full runtime request and normalizes dir to absolute', () => {
    const value = good(baseBody());
    expect(value.dir).toBe(siteDir);
    expect(value.key).toBe('site-abc123');
    expect(value.limits.rssMb).toBe(256);
  });

  it('resolves a relative dir against the work root', () => {
    expect(good(baseBody({ dir: 'site-a' })).dir).toBe(siteDir);
  });

  it('accepts a static request without start', () => {
    const value = good(baseBody({ kind: 'static', start: undefined }));
    expect(value.kind).toBe('static');
    expect(value.start).toBeUndefined();
  });

  it("accepts argv[0] 'node' and the runner execPath", () => {
    expect(good(baseBody({ start: ['node', 'server.mjs'] })).start?.[0]).toBe('node');
    expect(good(baseBody({ start: [process.execPath, 'server.mjs'] })).start?.[0]).toBe(process.execPath);
  });

  it('accepts writableDir inside the root', () => {
    const value = good(baseBody({ writableDir: join(siteDir, 'data') }));
    expect(value.writableDir).toBe(join(siteDir, 'data'));
  });

  it('accepts the whole uid pool edges', () => {
    for (const uid of [19998, 19999, 20000, 20499]) expect(good(baseBody({ uid })).uid).toBe(uid);
  });

  it('accepts limit range edges', () => {
    const value = good(baseBody({ limits: { cpuSeconds: 604800, addressSpaceMb: 65536, maxProcesses: 1024, fileSizeMb: 4096, rssMb: 8192 } }));
    expect(value.limits.cpuSeconds).toBe(604800);
    expect(good(baseBody({ limits: { cpuSeconds: 1, addressSpaceMb: 256, maxProcesses: 1, fileSizeMb: 1, rssMb: 64 } })).limits.rssMb).toBe(64);
  });

  it('siteUidList covers demos, imports and the site pool', () => {
    const uids = siteUidList();
    expect(uids[0]).toBe(19998);
    expect(uids[1]).toBe(19999);
    expect(uids).toContain(20000);
    expect(uids).toContain(20499);
    expect(uids).toHaveLength(502);
  });
});

describe('validateSpawnBody — rejects', () => {
  it('rejects a non-object body', () => {
    expect(bad('nope')).toContain('object');
    expect(bad(null)).toContain('object');
    expect(bad([1, 2])).toContain('object');
  });

  it('rejects malformed keys', () => {
    for (const key of ['', '-lead', 'Upper', 'under_score', 'a'.repeat(81), 'white space']) {
      expect(bad(baseBody({ key }))).toContain('key');
    }
    expect(good(baseBody({ key: 'a'.repeat(80) })).key).toHaveLength(80);
  });

  it('rejects bad rowVersion', () => {
    for (const rowVersion of [0, -1, 1.5, '1', null]) {
      expect(bad(baseBody({ rowVersion }))).toContain('rowVersion');
    }
  });

  it('rejects a dir escaping the work root', () => {
    expect(bad(baseBody({ dir: outsideDir }))).toContain('escapes RUNNER_WORK_ROOT');
    expect(bad(baseBody({ dir: join(workRoot, '..', 'escape') }))).toContain('escapes RUNNER_WORK_ROOT');
    expect(bad(baseBody({ dir: '/etc' }))).toContain('escapes RUNNER_WORK_ROOT');
  });

  it('rejects a missing dir and a dir that is a file', () => {
    expect(bad(baseBody({ dir: join(workRoot, 'nope') }))).toContain('does not exist');
    expect(bad(baseBody({ dir: join(workRoot, 'a-file.txt') }))).toContain('not a directory');
  });

  it('rejects a writableDir outside the root', () => {
    expect(bad(baseBody({ writableDir: outsideDir }))).toContain('writableDir');
  });

  it('rejects uids outside the pool', () => {
    for (const uid of [0, 1000, 19997, 20500, 20000.5]) {
      expect(bad(baseBody({ uid }))).toContain('uid');
    }
  });

  it('rejects a gid different from RUNNER_SITE_GID', () => {
    expect(bad(baseBody({ gid: 19991 }))).toContain('gid');
    expect(bad(baseBody({ gid: 0 }))).toContain('gid');
  });

  it('rejects env keys on the credential denylist', () => {
    for (const name of ['API_SECRET', 'DATABASE_URL', 'MY_TOKEN_COUNT', 'APP_PASSWORD_HASH', 'MFA_KEY', 'PRIVATE_THING', 'PARTNER_WEBHOOK_KEY', 'SESSION_SECRET']) {
      expect(bad(baseBody({ env: { [name]: 'x' } })), name).toContain('denied');
    }
  });

  it('rejects malformed env', () => {
    expect(bad(baseBody({ env: { path: '/x' } }))).toContain('not a valid environment name');
    expect(bad(baseBody({ env: { GOOD: 42 } }))).toContain('env value');
    expect(bad(baseBody({ env: { GOOD: 'x'.repeat(4097) } }))).toContain('env value');
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`K${i}`] = 'v';
    expect(bad(baseBody({ env: many }))).toContain('at most 64');
  });

  it('rejects a runtime request without start', () => {
    expect(bad(baseBody({ start: undefined }))).toContain('start is required');
  });

  it("rejects argv[0] that is not 'node' or the execPath", () => {
    expect(bad(baseBody({ start: ['/bin/sh', '-c', 'x'] }))).toContain("start[0]");
    expect(bad(baseBody({ start: ['nodejs', 'server.mjs'] }))).toContain("start[0]");
    expect(bad(baseBody({ start: ['/usr/bin/python3', 'x.py'] }))).toContain("start[0]");
  });

  it('rejects oversize or NUL-bearing argv elements', () => {
    expect(bad(baseBody({ start: ['node', 'x'.repeat(513)] }))).toContain('512');
    expect(bad(baseBody({ start: ['node', 'a\0b'] }))).toContain('512');
    expect(bad(baseBody({ start: Array.from({ length: 33 }, () => 'node') }))).toContain('1..32');
    expect(bad(baseBody({ start: [] }))).toContain('1..32');
    expect(bad(baseBody({ start: ['node', 42] }))).toContain('512');
  });

  it('rejects out-of-range limits', () => {
    const limits = { cpuSeconds: 60, addressSpaceMb: 32768, maxProcesses: 1024, fileSizeMb: 64, rssMb: 256 };
    expect(bad(baseBody({ limits: { ...limits, cpuSeconds: 0 } }))).toContain('cpuSeconds');
    expect(bad(baseBody({ limits: { ...limits, cpuSeconds: 604801 } }))).toContain('cpuSeconds');
    expect(bad(baseBody({ limits: { ...limits, addressSpaceMb: 255 } }))).toContain('addressSpaceMb');
    expect(bad(baseBody({ limits: { ...limits, maxProcesses: 1025 } }))).toContain('maxProcesses');
    expect(bad(baseBody({ limits: { ...limits, fileSizeMb: 4097 } }))).toContain('fileSizeMb');
    expect(bad(baseBody({ limits: { ...limits, rssMb: 63 } }))).toContain('rssMb');
    expect(bad(baseBody({ limits: { ...limits, rssMb: 8193 } }))).toContain('rssMb');
    expect(bad(baseBody({ limits: undefined }))).toContain('limits');
  });

  it('rejects a bad healthPath', () => {
    expect(bad(baseBody({ healthPath: 'health' }))).toContain('healthPath');
    expect(bad(baseBody({ healthPath: '/has space' }))).toContain('healthPath');
    expect(bad(baseBody({ healthPath: `/${'x'.repeat(300)}` }))).toContain('healthPath');
  });

  it('rejects an unknown kind', () => {
    expect(bad(baseBody({ kind: 'process' }))).toContain('kind');
  });
});

describe('validateStopBody', () => {
  it('accepts a well-formed stop', () => {
    const result = validateStopBody({ key: 'site-1', rowVersion: 3 });
    expect(result).toEqual({ ok: true, value: { key: 'site-1', rowVersion: 3 } });
  });

  it('rejects malformed stops', () => {
    expect(validateStopBody({ key: 'Bad', rowVersion: 1 }).ok).toBe(false);
    expect(validateStopBody({ key: 'ok', rowVersion: 0 }).ok).toBe(false);
    expect(validateStopBody('nope').ok).toBe(false);
  });
});

describe('isWithinRoot', () => {
  it('matches the root itself and children only', () => {
    expect(isWithinRoot(workRoot, workRoot)).toBe(true);
    expect(isWithinRoot(workRoot, siteDir)).toBe(true);
    expect(isWithinRoot(workRoot, outsideDir)).toBe(false);
    expect(isWithinRoot(workRoot, `${workRoot}-sibling`)).toBe(false);
  });
});
