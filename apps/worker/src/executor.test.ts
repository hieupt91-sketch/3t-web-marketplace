import { describe, expect, it } from 'vitest';
import { runIsolated, runIsolatedOrThrow } from './executor.js';

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
