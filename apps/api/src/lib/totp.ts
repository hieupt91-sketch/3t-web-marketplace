import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Minimal RFC 6238 TOTP (SHA-1, 30 s step, 6 digits). No new dependency. */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

export function decodeBase32(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('totp.invalid_secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpCode(secret: string, atMs: number = Date.now()): string {
  return hotp(decodeBase32(secret), BigInt(Math.floor(atMs / 30000)));
}

/** Accept the current step plus one step of clock skew on either side. */
export function verifyTotp(secret: string, code: string, atMs: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = BigInt(Math.floor(atMs / 30000));
  const key = decodeBase32(secret);
  return hotp(key, step - 1n) === code || hotp(key, step) === code || hotp(key, step + 1n) === code;
}

export function totpAuthUri(secret: string, account: string, issuer = '3T Web Marketplace'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
