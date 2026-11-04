import { describe, expect, it } from 'vitest';
import { staticServeArgv } from './runtime-agent.ts';

/**
 * Regression: the static serve spawn must resolve node through PATH,
 * never through process.execPath. Under sandbox fencing the child runs
 * as the site's dedicated UID; the worker's node binary can live under a
 * tree that UID cannot traverse (nvm-style homes, private install dirs),
 * and an absolute execPath then fails before the server ever boots —
 * every static site provision died at its health check in such an
 * environment while runtime spawns (PATH-resolved 'node') worked.
 */
describe('staticServeArgv', () => {
  it('resolves node via PATH and points at the bundled serve-dir script', () => {
    const argv = staticServeArgv('/srv/sites/abc');
    expect(argv[0]).toBe('node');
    expect(argv[0]).not.toBe(process.execPath);
    expect(argv[1]).toMatch(/serve-dir\.mjs$/);
    expect(argv[2]).toBe('/srv/sites/abc');
  });
});
