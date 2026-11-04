import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { translate, type Locale } from '@3t/i18n';

export type MailTemplate = 'verify_email' | 'reset_password' | 'account_exists' | 'password_changed';

export interface MailMessage {
  to: string;
  locale: Locale;
  template: MailTemplate;
  /** Template variables; links may carry one-time tokens and must never be logged. */
  params: Record<string, string>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function renderMail(message: MailMessage): { subject: string; text: string } {
  const subject = translate(message.locale, `mail.${message.template}.subject`, message.params);
  const text = translate(message.locale, `mail.${message.template}.body`, message.params);
  return { subject, text };
}

/**
 * Development transport: writes RFC 822-style files into a git-ignored directory so a developer
 * can open verification/reset links locally. Nothing leaves the machine. Refused in production.
 */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(message: MailMessage): Promise<void> {
    const { subject, text } = renderMail(message);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${message.template}-${randomUUID().slice(0, 8)}.eml`;
    const body = `To: ${message.to}\nSubject: ${subject}\nContent-Language: ${message.locale}\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`;
    await writeFile(join(this.dir, name), body, { mode: 0o600 });
  }
}

/** No email provider configured: mail is not sent and callers must not claim it was. */
export class DisabledMailer implements Mailer {
  async send(): Promise<void> {}
}

/** Test double capturing messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** The slice of the Resend settings the mailer consumes (see lib/settings-mail.ts). */
export interface ResendMailConfig {
  enabled: boolean;
  apiKey: string;
  from: string;
}

export type ResendSettingsLoader = () => Promise<ResendMailConfig | null>;

/** A send that reached the provider and failed (or never reached it).
 *  `status` is the provider's HTTP status, or null for a network error
 *  and for "not configured". Carries no key material and no message body. */
export class MailProviderError extends Error {
  constructor(public readonly status: number | null) {
    super(status === null ? 'mail provider send failed' : `mail provider responded with status ${status}`);
    this.name = 'MailProviderError';
  }
}

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Resend transport (https://resend.com). Settings are loaded per send so
 * an owner rotating the key or toggling the channel in admin takes
 * effect without a restart. Unconfigured (no settings row, disabled,
 * no key, no From) behaves exactly like DisabledMailer: send() is a
 * silent no-op — email is best-effort and must never break the auth
 * flows that trigger it.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly loadSettings: ResendSettingsLoader,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const settings = await this.configured();
    if (!settings) return;
    const { subject, text } = renderMail(message);
    try {
      await this.post(settings, message.to, subject, text);
    } catch (err) {
      // Structured failure event for the log pipeline. Only the template
      // name and the provider status are recorded — params carry
      // one-time links and must never be logged.
      const status = err instanceof MailProviderError ? err.status : null;
      console.error(JSON.stringify({ event: 'mail_send_failed', template: message.template, status }));
    }
  }

  /** Raw send for the admin "send test email" action. Unlike send(),
   *  failures surface to the caller as MailProviderError (with the
   *  provider status) so the UI can report them; an unconfigured
   *  transport throws MailProviderError with status null. */
  async sendRaw(input: { to: string; subject: string; text: string }): Promise<void> {
    const settings = await this.configured();
    if (!settings) throw new MailProviderError(null);
    await this.post(settings, input.to, input.subject, input.text);
  }

  /** Settings when mail can actually be sent, else null. A loader
   *  failure reads as "not configured" (fail closed, silently). */
  private async configured(): Promise<ResendMailConfig | null> {
    let settings: ResendMailConfig | null;
    try {
      settings = await this.loadSettings();
    } catch {
      return null;
    }
    if (!settings || !settings.enabled || settings.apiKey === '' || settings.from === '') return null;
    return settings;
  }

  private async post(settings: ResendMailConfig, to: string, subject: string, text: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: settings.from, to: [to], subject, text }),
      });
    } catch {
      throw new MailProviderError(null);
    }
    if (!res.ok) throw new MailProviderError(res.status);
  }
}
