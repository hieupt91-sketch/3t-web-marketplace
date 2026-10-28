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
