import { describe, expect, it } from 'vitest';
import { loadConfig, type PlatformConfig } from './config.ts';

/**
 * Sandbox Phase 1 (audit C-01): the worker delegates template spawns to a
 * dedicated site-runner when RUNTIME_AGENT_URL is set. The runner is
 * authenticated by RUNNER_TOKEN; production must refuse to boot in
 * remote mode without it (an unauthenticated spawn endpoint would be
 * worse than no runner at all).
 */
describe('site-runner config (Phase 1)', () => {
  it('defaults to local spawn mode with a 1024 MiB RSS cap', () => {
    const config = loadConfig({ env: 'test' });
    expect(config.runtimeAgentUrl).toBe('');
    expect(config.runnerToken).toBe('');
    expect(config.siteLimitRssMb).toBe(1024);
  });

  it('accepts remote mode outside production without a token (dev/show env)', () => {
    const config = loadConfig({ env: 'test', runtimeAgentUrl: 'http://127.0.0.1:4300' });
    expect(config.runtimeAgentUrl).toBe('http://127.0.0.1:4300');
    expect(config.runnerToken).toBe('');
  });

  const productionSafe: Partial<PlatformConfig> = {
    env: 'production',
    databaseUrl: 'postgres://marketplace@db:5432/marketplace',
    portalOrigin: 'https://webmaket.com',
    previewOriginTemplate: 'https://{label}.preview.webmaket.com',
    previewBaseDomain: 'preview.webmaket.com',
    siteBaseDomain: 'webmaket.com',
    siteOriginTemplate: 'https://{label}.webmaket.com',
    cookieSecure: true,
    mailTransport: 'disabled',
    mockPaymentSecret: 'prod-mock-secret',
    partnerLinkSecret: 'prod-partner-link-secret',
    partnerWebhookKey: 'prod-partner-webhook-key',
    mfaKey: 'prod-mfa-key',
  };

  it('production: remote mode without RUNNER_TOKEN is refused', () => {
    expect(() => loadConfig({ ...productionSafe, runtimeAgentUrl: 'http://site-runner:4300', runnerToken: '' })).toThrow(
      'RUNNER_TOKEN is required when RUNTIME_AGENT_URL is set in production',
    );
  });

  it('production: remote mode with a token loads', () => {
    const config = loadConfig({ ...productionSafe, runtimeAgentUrl: 'http://site-runner:4300', runnerToken: 'tok', siteLimitRssMb: 2048 });
    expect(config.runtimeAgentUrl).toBe('http://site-runner:4300');
    expect(config.runnerToken).toBe('tok');
    expect(config.siteLimitRssMb).toBe(2048);
  });

  it('production: local mode needs no runner token', () => {
    const config = loadConfig({ ...productionSafe });
    expect(config.runtimeAgentUrl).toBe('');
  });
});
