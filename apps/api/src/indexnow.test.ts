import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndexNowPayload, indexNowEnabled, pingIndexNow, storefrontTemplateUrls } from './lib/indexnow.ts';

/**
 * IndexNow submission (lib/indexnow.ts): the payload must match the protocol
 * shape the engines expect, submission must stay silent outside production
 * (unless explicitly opted in), and a failed submission must never surface
 * to the caller — it is fire-and-forget from admin request handlers.
 */
describe('indexnow', () => {
  const savedEnv = { APP_ENV: process.env.APP_ENV, INDEXNOW_ENABLED: process.env.INDEXNOW_ENABLED };
  let fetchCalls: { url: unknown; init: { method?: string; body?: string } }[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchCalls = [];
    delete process.env.APP_ENV;
    delete process.env.INDEXNOW_ENABLED;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (savedEnv.APP_ENV === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = savedEnv.APP_ENV;
    if (savedEnv.INDEXNOW_ENABLED === undefined) delete process.env.INDEXNOW_ENABLED; else process.env.INDEXNOW_ENABLED = savedEnv.INDEXNOW_ENABLED;
  });

  function stubFetch(impl: (url: unknown, init: { method?: string; body?: string }) => Promise<{ status: number }>) {
    vi.stubGlobal('fetch', async (url: unknown, init: { method?: string; body?: string }) => {
      fetchCalls.push({ url, init });
      return impl(url, init);
    });
  }

  it('submits the protocol payload shape in production, deduped', async () => {
    process.env.APP_ENV = 'production';
    stubFetch(async () => ({ status: 202 }));
    await pingIndexNow([
      'https://webmaket.com/vi/templates/abc',
      'https://webmaket.com/vi/templates/abc',
      'https://webmaket.com/en/templates/abc',
    ]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://api.indexnow.org/indexnow');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(JSON.parse(fetchCalls[0]!.init.body!)).toEqual({
      host: 'webmaket.com',
      key: 'f93d1b0371a611353b5c7c3e2d7872f4',
      keyLocation: 'https://webmaket.com/f93d1b0371a611353b5c7c3e2d7872f4.txt',
      urlList: ['https://webmaket.com/vi/templates/abc', 'https://webmaket.com/en/templates/abc'],
    });
    // One structured log line with the engine status, no body/key material beyond the event.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toEqual({ event: 'indexnow_ping', status: 202, urls: 2 });
  });

  it('stays silent outside production unless INDEXNOW_ENABLED=true', async () => {
    stubFetch(async () => ({ status: 200 }));
    process.env.APP_ENV = 'test';
    await pingIndexNow(['https://webmaket.com/vi/templates']);
    process.env.APP_ENV = 'development';
    await pingIndexNow(['https://webmaket.com/vi/templates']);
    delete process.env.APP_ENV;
    await pingIndexNow(['https://webmaket.com/vi/templates']);
    expect(fetchCalls).toHaveLength(0);
    expect(indexNowEnabled()).toBe(false);

    process.env.INDEXNOW_ENABLED = 'true';
    expect(indexNowEnabled()).toBe(true);
    await pingIndexNow(['https://webmaket.com/vi/templates']);
    expect(fetchCalls).toHaveLength(1);
  });

  it('swallows network failures and HTTP errors without throwing', async () => {
    process.env.APP_ENV = 'production';
    stubFetch(async () => { throw new Error('socket hangup'); });
    await expect(pingIndexNow(['https://webmaket.com/vi/templates'])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0])).event).toBe('indexnow_failed');

    stubFetch(async () => ({ status: 500 }));
    await expect(pingIndexNow(['https://webmaket.com/vi/templates'])).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]![0])).status).toBe(500);
  });

  it('does not submit an empty list or foreign-host URLs', async () => {
    process.env.APP_ENV = 'production';
    stubFetch(async () => ({ status: 200 }));
    await pingIndexNow([]);
    await pingIndexNow(['https://example.com/vi/templates/abc', 'not a url']);
    expect(fetchCalls).toHaveLength(0);
    expect(buildIndexNowPayload(['https://example.com/x'])).toBeNull();
  });

  it('caps the list at the 10,000-URL protocol limit', () => {
    const urls = Array.from({ length: 10_001 }, (_, i) => `https://webmaket.com/vi/templates/t-${i}`);
    const payload = buildIndexNowPayload(urls);
    expect(payload!.urlList).toHaveLength(10_000);
  });

  it('builds the per-template URL set: detail in both locales + both listings', () => {
    expect(storefrontTemplateUrls('phu-tung-o-to')).toEqual([
      'https://webmaket.com/vi/templates/phu-tung-o-to',
      'https://webmaket.com/en/templates/phu-tung-o-to',
      'https://webmaket.com/vi/templates',
      'https://webmaket.com/en/templates',
    ]);
  });
});
