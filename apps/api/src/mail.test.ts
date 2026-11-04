import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailProviderError, ResendMailer, renderMail, type MailMessage, type ResendMailConfig } from './mail.ts';

const CONFIGURED: ResendMailConfig = { enabled: true, apiKey: 're_test_key_123', from: 'webmaket <no-reply@webmaket.com>' };

const MESSAGE: MailMessage = {
  to: 'buyer@example.com',
  locale: 'en',
  template: 'verify_email',
  params: { link: 'https://webmaket.com/verify?token=SUPER_SECRET_TOKEN' },
};

interface RecordedCall { url: string; init: RequestInit | undefined }

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { calls, impl };
}

const ok = () => new Response(JSON.stringify({ id: 'em_123' }), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResendMailer.send', () => {
  it('posts the rendered message to the Resend API with the bearer key', async () => {
    const { calls, impl } = fakeFetch(ok);
    const mailer = new ResendMailer(async () => CONFIGURED, impl);
    await mailer.send(MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init?.method).toBe('POST');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test_key_123');
    const expected = renderMail(MESSAGE);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      from: 'webmaket <no-reply@webmaket.com>',
      to: ['buyer@example.com'],
      subject: expected.subject,
      text: expected.text,
    });
  });

  it('no-ops when there are no settings, when disabled, or when key/from is missing', async () => {
    const loaders: Array<() => Promise<ResendMailConfig | null>> = [
      async () => null,
      async () => ({ ...CONFIGURED, enabled: false }),
      async () => ({ ...CONFIGURED, apiKey: '' }),
      async () => ({ ...CONFIGURED, from: '' }),
    ];
    for (const load of loaders) {
      const { calls, impl } = fakeFetch(ok);
      await new ResendMailer(load, impl).send(MESSAGE);
      expect(calls).toHaveLength(0);
    }
  });

  it('swallows a provider 500 and logs a structured event without any message params', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { logged.push(String(line)); });
    const { impl } = fakeFetch(() => new Response('provider exploded', { status: 500 }));
    const mailer = new ResendMailer(async () => CONFIGURED, impl);
    await expect(mailer.send(MESSAGE)).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    const event = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(event).toEqual({ event: 'mail_send_failed', template: 'verify_email', status: 500 });
    expect(logged[0]).not.toContain('SUPER_SECRET_TOKEN');
    expect(logged[0]).not.toContain('re_test_key_123');
  });

  it('swallows a network error and logs it with a null status', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { logged.push(String(line)); });
    const { impl } = fakeFetch(() => Promise.reject(new Error('socket hang up')));
    const mailer = new ResendMailer(async () => CONFIGURED, impl);
    await expect(mailer.send(MESSAGE)).resolves.toBeUndefined();
    const event = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(event).toEqual({ event: 'mail_send_failed', template: 'verify_email', status: null });
  });
});

describe('ResendMailer.sendRaw', () => {
  it('delivers a raw message through the same provider path', async () => {
    const { calls, impl } = fakeFetch(ok);
    const mailer = new ResendMailer(async () => CONFIGURED, impl);
    await mailer.sendRaw({ to: 'owner@example.com', subject: 'webmaket — email test', text: 'hello' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      from: 'webmaket <no-reply@webmaket.com>',
      to: ['owner@example.com'],
      subject: 'webmaket — email test',
      text: 'hello',
    });
  });

  it('throws MailProviderError carrying the provider status on a non-2xx response', async () => {
    const { impl } = fakeFetch(() => new Response('unprocessable', { status: 422 }));
    const mailer = new ResendMailer(async () => CONFIGURED, impl);
    const err = await mailer.sendRaw({ to: 'owner@example.com', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailProviderError);
    expect((err as MailProviderError).status).toBe(422);
  });

  it('throws MailProviderError with a null status when unconfigured', async () => {
    const { calls, impl } = fakeFetch(ok);
    const mailer = new ResendMailer(async () => null, impl);
    const err = await mailer.sendRaw({ to: 'owner@example.com', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailProviderError);
    expect((err as MailProviderError).status).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
