import { describe, expect, it } from 'vitest';
import { loadRunnerConfig } from './main.js';

describe('loadRunnerConfig', () => {
  it('refuses to start without RUNNER_TOKEN', () => {
    expect(() => loadRunnerConfig({})).toThrow(/RUNNER_TOKEN/);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: '', RUNNER_WORK_ROOT: '/tmp/w' })).toThrow(/RUNNER_TOKEN/);
  });

  it('refuses to start without RUNNER_WORK_ROOT', () => {
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: 'x' })).toThrow(/RUNNER_WORK_ROOT/);
  });

  it('applies the contract defaults', () => {
    const config = loadRunnerConfig({ RUNNER_TOKEN: 'tok', RUNNER_WORK_ROOT: '/tmp/w' });
    expect(config).toEqual({ token: 'tok', port: 4300, workRoot: '/tmp/w', siteGid: 19990, egressOn: false });
  });

  it('parses explicit port, gid and egress', () => {
    const config = loadRunnerConfig({
      RUNNER_TOKEN: 'tok',
      RUNNER_WORK_ROOT: '/tmp/w',
      RUNNER_PORT: '4400',
      RUNNER_SITE_GID: '20000',
      RUNNER_EGRESS: 'on',
    });
    expect(config.port).toBe(4400);
    expect(config.siteGid).toBe(20000);
    expect(config.egressOn).toBe(true);
  });

  it('treats any RUNNER_EGRESS other than "on" as off', () => {
    for (const value of ['off', '1', 'true', 'ON']) {
      expect(loadRunnerConfig({ RUNNER_TOKEN: 't', RUNNER_WORK_ROOT: '/tmp/w', RUNNER_EGRESS: value }).egressOn).toBe(false);
    }
  });

  it('rejects a bad port or gid', () => {
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: 't', RUNNER_WORK_ROOT: '/tmp/w', RUNNER_PORT: 'abc' })).toThrow(/RUNNER_PORT/);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: 't', RUNNER_WORK_ROOT: '/tmp/w', RUNNER_PORT: '0' })).toThrow(/RUNNER_PORT/);
    expect(() => loadRunnerConfig({ RUNNER_TOKEN: 't', RUNNER_WORK_ROOT: '/tmp/w', RUNNER_SITE_GID: '-1' })).toThrow(/RUNNER_SITE_GID/);
  });
});
