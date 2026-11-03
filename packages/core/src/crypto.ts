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

/**
 * Constant-time equality for secret strings (audit L-06). The length
 * check leaks only the length, which is public for fixed-size hashes
 * and codes; `timingSafeEqual` itself throws on length mismatch, so
 * the guard is required for it to be usable at all.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Constant-time equality for hex-encoded secrets/hashes (audit L-06).
 * Inputs of different lengths, odd length, or non-hex content never
 * compare equal (and never throw).
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]*$/.test(a) || !/^[0-9a-fA-F]*$/.test(b)) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && (ba.length === 0 || timingSafeEqual(ba, bb));
}

/* ---------------- MFA backup codes (audit L-05) ----------------
 * New codes carry 80 bits of entropy (see the generator in the API's
 * mfa route) and are stored as scrypt hashes — the same slow KDF as
 * passwords — under an `s1$` prefix so entries are distinguishable
 * from the legacy format: a bare 64-char SHA-256 hex of the code.
 * Verification accepts BOTH formats, so codes issued before this
 * change keep working (and are still consumed on use) instead of
 * locking their owners out.
 */
export const BACKUP_CODE_HASH_PREFIX = 's1$';

/** Codes are displayed grouped/upper-case; entry may vary in case and separators. */
export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export async function hashBackupCode(code: string, cost: number): Promise<string> {
  return BACKUP_CODE_HASH_PREFIX + (await hashPassword(normalizeBackupCode(code), cost));
}

export async function verifyBackupCode(code: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const normalized = normalizeBackupCode(code);
  if (stored.startsWith(BACKUP_CODE_HASH_PREFIX)) {
    return verifyPassword(normalized, stored.slice(BACKUP_CODE_HASH_PREFIX.length));
  }
  // Legacy entry: bare SHA-256 hex of the code (audit L-05).
  if (/^[0-9a-fA-F]{64}$/.test(stored)) {
    return safeEqualHex(hashToken(normalized).toString('hex'), stored);
  }
  return false;
}

/**
 * Index of the stored entry matching `code`, or -1. Non-code-shaped
 * input (e.g. a 6-digit TOTP guess) is rejected before any scrypt
 * work runs, so the TOTP path never pays the KDF cost.
 */
export async function findBackupCodeIndex(code: string, storedList: readonly string[]): Promise<number> {
  const normalized = normalizeBackupCode(code);
  if (!/^[0-9A-F]{10,20}$/.test(normalized)) return -1;
  for (let i = 0; i < storedList.length; i++) {
    if (await verifyBackupCode(normalized, storedList[i]!)) return i;
  }
  return -1;
}
