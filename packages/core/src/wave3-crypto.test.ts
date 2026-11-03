import { describe, expect, it } from 'vitest';
import {
  BACKUP_CODE_HASH_PREFIX,
  decryptSecret,
  encryptSecret,
  findBackupCodeIndex,
  hashBackupCode,
  hashToken,
  normalizeBackupCode,
  safeEqual,
  safeEqualHex,
  verifyBackupCode,
} from './crypto.ts';

/**
 * Wave-3 audit fixes: constant-time comparisons (L-06) and MFA backup
 * codes with >=80-bit codes stored as scrypt, legacy SHA-256 entries
 * still accepted (L-05). Pure unit tests — no database.
 */
const COST = 1024; // test-scrypt cost, same as the API test contexts

describe('safeEqualHex (L-06)', () => {
  const a = 'ab12cd34'.repeat(8); // 64 hex chars, like a sha256 hex

  it('accepts equal hex strings regardless of case', () => {
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, a.toUpperCase())).toBe(true);
  });

  it('rejects unequal hex strings of the same length', () => {
    const b = `${a.slice(0, 63)}0`;
    expect(b).not.toBe(a);
    expect(safeEqualHex(a, b)).toBe(false);
  });

  it('rejects different-length inputs without throwing', () => {
    expect(safeEqualHex(a, a.slice(0, 32))).toBe(false);
    expect(safeEqualHex(a.slice(0, 32), a)).toBe(false);
    expect(safeEqualHex(a, '')).toBe(false);
  });

  it('rejects non-hex and odd-length inputs without throwing', () => {
    expect(safeEqualHex('zzzz', 'zzzz')).toBe(false);
    expect(safeEqualHex('abc', 'abc')).toBe(false);
    expect(safeEqualHex(a, 'not-hex-at-all-not-hex-at-all-not-hex-at-all-not-hex-at-al')).toBe(false);
  });
});

describe('safeEqual (L-06)', () => {
  it('compares strings constant-time with a length guard', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
    expect(safeEqual('123456', '123457')).toBe(false);
    expect(safeEqual('123456', '12345')).toBe(false);
  });
});

describe('MFA backup codes (L-05)', () => {
  const NEW_CODE = 'ABCDE-12345-F6789-0ABCD'; // grouped display form of 20 hex chars

  it('normalises grouped/lowercase entry to the stored form', () => {
    expect(normalizeBackupCode(NEW_CODE)).toBe('ABCDE12345F67890ABCD');
    expect(normalizeBackupCode(' abcde 12345 ')).toBe('ABCDE12345');
  });

  it('stores new codes as prefixed scrypt hashes, never plaintext or bare sha256', async () => {
    const stored = await hashBackupCode(NEW_CODE, COST);
    expect(stored.startsWith(BACKUP_CODE_HASH_PREFIX)).toBe(true);
    expect(stored.startsWith('s1$scrypt$')).toBe(true);
    expect(stored).not.toContain('ABCDE12345');
    expect(stored).not.toBe(hashToken('ABCDE12345F67890ABCD').toString('hex'));
  });

  it('verifies a new code in display, plain and lowercase forms', async () => {
    const stored = await hashBackupCode(NEW_CODE, COST);
    expect(await verifyBackupCode(NEW_CODE, stored)).toBe(true);
    expect(await verifyBackupCode('ABCDE12345F67890ABCD', stored)).toBe(true);
    expect(await verifyBackupCode('abcde-12345-f6789-0abcd', stored)).toBe(true);
  });

  it('still verifies legacy bare sha256 entries', async () => {
    const legacyCode = 'ABCDEF0123'; // pre-L-05 format: 10 hex chars
    const legacyStored = hashToken(legacyCode).toString('hex');
    expect(legacyStored).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyBackupCode(legacyCode, legacyStored)).toBe(true);
    expect(await verifyBackupCode(legacyCode.toLowerCase(), legacyStored)).toBe(true);
  });

  it('rejects wrong codes against both storage formats', async () => {
    const stored = await hashBackupCode(NEW_CODE, COST);
    expect(await verifyBackupCode('FFFFF-FFFFF-FFFFF-FFFFF', stored)).toBe(false);
    const legacyStored = hashToken('ABCDEF0123').toString('hex');
    expect(await verifyBackupCode('ABCDEF0124', legacyStored)).toBe(false);
    expect(await verifyBackupCode('ABCDE12345F67890ABCD', 'not-a-hash')).toBe(false);
  });

  it('findBackupCodeIndex locates new and legacy entries and misses cleanly', async () => {
    const stored = [
      hashToken('ABCDEF0123').toString('hex'),
      await hashBackupCode(NEW_CODE, COST),
      await hashBackupCode('11111-22222-33333-44444', COST),
    ];
    expect(await findBackupCodeIndex(NEW_CODE, stored)).toBe(1);
    expect(await findBackupCodeIndex('ABCDEF0123', stored)).toBe(0);
    expect(await findBackupCodeIndex('99999-99999-99999-99999', stored)).toBe(-1);
    // A 6-digit TOTP-shaped guess never reaches the scrypt entries.
    expect(await findBackupCodeIndex('123456', stored)).toBe(-1);
  });
});

describe('secret envelope (H2 fix 1: worker → API job-result hand-off)', () => {
  it('round-trips a secret and rejects the wrong key', () => {
    const sealed = encryptSecret('server-key-A', 'tok-secret-123');
    expect(sealed).not.toContain('tok-secret-123');
    expect(decryptSecret('server-key-A', sealed)).toBe('tok-secret-123');
    expect(() => decryptSecret('server-key-B', sealed)).toThrow();
  });

  it('produces a fresh envelope per call (random IV)', () => {
    expect(encryptSecret('k', 'same-value')).not.toBe(encryptSecret('k', 'same-value'));
  });
});
