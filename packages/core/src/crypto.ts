import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL safe. Only its hash is stored. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lower-case DNS-safe label with `bytes * 8` bits of entropy (used for preview hostnames). */
export function randomLabel(bytes = 20): string {
  const data = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function scryptAsync(password: string, salt: Buffer, N: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Password hash format: scrypt$N$r$p$saltB64$hashB64. */
export async function hashPassword(password: string, cost: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, cost, 32);
  return `scrypt$${cost}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || r !== '8' || p !== '1' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A fixed hash used to keep login timing similar when the account does not exist. */
export async function dummyPasswordCheck(password: string, cost: number): Promise<void> {
  await scryptAsync(password, Buffer.alloc(16), cost, 32);
}
