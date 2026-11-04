import type { Db } from '@3t/core';
import { openSettingSecret, sealSettingSecret } from './secret-store.ts';

/**
 * Resend mail settings (DB row `mail.resend`, managed from Admin →
 * Settings → Email under step-up). The API key is a provider credential,
 * so — exactly like the gateway secret keys — it is stored sealed with
 * the server-side partner webhook key and only ever opened server-side:
 * the admin API returns a `*_configured` flag, never the key itself.
 */
export const MAIL_RESEND_SETTINGS_KEY = 'mail.resend';

export interface MailResendSettings {
  enabled: boolean;
  /** Plaintext API key (opened from its sealed form); '' when unset or undecryptable. */
  apiKey: string;
  fromAddress: string;
  fromName: string;
  /** Composed From header value: `"Name" <addr>` when a name is set, else the bare address; '' when no address. */
  from: string;
}

export function composeFromAddress(address: string, name: string): string {
  if (address === '') return '';
  if (name === '') return address;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function loadMailResendSettings(db: Db, serverKey: string): Promise<MailResendSettings> {
  const { rows } = await db.query<{ value_json: Record<string, unknown> }>(
    'SELECT value_json FROM settings WHERE key = $1',
    [MAIL_RESEND_SETTINGS_KEY],
  );
  const raw = rows[0]?.value_json ?? {};
  const fromAddress = clean(raw.from_address);
  const fromName = clean(raw.from_name);
  return {
    enabled: raw.enabled === true,
    apiKey: openSettingSecret(serverKey, clean(raw.api_key)),
    fromAddress,
    fromName,
    from: composeFromAddress(fromAddress, fromName),
  };
}

export interface MailResendSettingsInput {
  enabled: boolean;
  /** Plaintext key to store; pass the currently stored one to keep it. */
  apiKey: string;
  fromAddress: string;
  fromName: string;
}

export async function saveMailResendSettings(db: Db, serverKey: string, next: MailResendSettingsInput): Promise<void> {
  const value = {
    enabled: next.enabled,
    api_key: sealSettingSecret(serverKey, next.apiKey),
    from_address: next.fromAddress,
    from_name: next.fromName,
  };
  await db.query(
    `INSERT INTO settings (key, value_json) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, revision = settings.revision + 1`,
    [MAIL_RESEND_SETTINGS_KEY, JSON.stringify(value)],
  );
}
