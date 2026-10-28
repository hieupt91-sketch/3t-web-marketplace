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
