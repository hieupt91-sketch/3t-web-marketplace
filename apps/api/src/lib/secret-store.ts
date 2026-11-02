import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets the platform must retain to use later
 * (partner webhook signing secrets, MFA TOTP secrets). The key is a
 * server-side env value (never stored in the database); the key itself is
 * sha256-hashed before use so a short env string still yields a 256-bit key.
 */
export function encryptSecret(serverKey: string, secret: string): string {
  const key = createHash('sha256').update(serverKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(serverKey: string, encoded: string): string {
  const key = createHash('sha256').update(serverKey).digest();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Settings-JSON secrets (audit payments M2): payment credentials live in
 * the settings table, which any settings read (or a leaked backup) would
 * otherwise expose in plaintext. A sealed value is the string
 * "enc:v1:<base64 envelope>" so the JSON field keeps its string type and
 * presence checks (`!== ''`) keep working on the stored form.
 * sealSettingSecret is idempotent (an already-sealed value passes
 * through, so "keep current secret" saves never double-encrypt);
 * openSettingSecret accepts legacy plaintext unchanged, so values written
 * before this change keep working until the next settings save re-seals
 * them. A value that fails to decrypt (server key rotated) opens as ''
 * — "not configured" — which fails closed everywhere it is consumed.
 */
export const SETTING_SECRET_PREFIX = 'enc:v1:';

export function sealSettingSecret(serverKey: string, value: string): string {
  if (value === '' || value.startsWith(SETTING_SECRET_PREFIX)) return value;
  return SETTING_SECRET_PREFIX + encryptSecret(serverKey, value);
}

export function openSettingSecret(serverKey: string, value: string): string {
  if (!value.startsWith(SETTING_SECRET_PREFIX)) return value;
  try {
    return decryptSecret(serverKey, value.slice(SETTING_SECRET_PREFIX.length));
  } catch {
    return '';
  }
}
