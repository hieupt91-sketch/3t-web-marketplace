import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executorEnv, runIsolated, runIsolatedOrThrow } from './executor.js';

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

describe('runIsolated', () => {
  it('runs a succeeding command and reports its exit code', async () => {
    const res = await runIsolated(['node', '-e', 'console.log("ok")'], {
      cwd: process.cwd(),
      allowNetwork: false,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ok');
    expect(res.timedOut).toBe(false);
  });

  it('returns a real command failure as-is instead of masking it', async () => {
    const res = await runIsolated(['node', '-e', 'process.exit(3)'], {
      cwd: process.cwd(),
      allowNetwork: false,
    });
    expect(res.code).toBe(3);
  });

  it('executorEnv points HOME, TMPDIR and the npm cache outside the workdir', () => {
    const cwd = '/work/project';
    const scratch = '/work/.mp-exec-AbC123';
    const env = executorEnv(cwd, scratch);
    expect(env.HOME).toBe(scratch);
    expect(env.TMPDIR).toBe(join(scratch, 'tmp'));
    expect(env.npm_config_cache).toBe(join(scratch, 'npm-cache'));
    for (const value of [env.HOME!, env.TMPDIR!, env.npm_config_cache!]) {
      expect(inside(cwd, value)).toBe(false);
    }
  });

  it('runs with HOME/TMPDIR/npm cache in a sibling scratch dir, cleaned up afterwards, leaving no junk in the workdir', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'mp-exec-test-'));
    const res = await runIsolated(
      ['node', '-e', 'console.log([process.env.HOME, process.env.TMPDIR, process.env.npm_config_cache].join("|"))'],
      { cwd: workdir, allowNetwork: true },
    );
    expect(res.code).toBe(0);
    const [home, tmpDir, npmCache] = res.stdout.trim().split('|') as [string, string, string];
    expect(home).toBeTruthy();
    // All three live outside the project tree (in the per-run scratch dir)…
    expect(inside(workdir, home)).toBe(false);
    expect(inside(workdir, tmpDir)).toBe(false);
    expect(inside(workdir, npmCache)).toBe(false);
    expect(tmpDir.startsWith(home)).toBe(true);
    expect(npmCache.startsWith(home)).toBe(true);
    // …the scratch dir is removed when the run ends…
    expect(existsSync(home)).toBe(false);
    // …and no executor junk was created inside the workdir.
    expect(existsSync(join(workdir, '.npm-cache'))).toBe(false);
    expect(existsSync(join(workdir, '.tmp'))).toBe(false);
  });

  it('runIsolatedOrThrow throws with the given failure code on a failing build command', async () => {
    let caught: unknown;
    try {
      await runIsolatedOrThrow(['node', '-e', 'process.exit(1)'], { cwd: process.cwd(), allowNetwork: false }, 'build_failed');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('build_failed');
  });
});
