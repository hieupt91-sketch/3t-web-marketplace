import { describe, expect, it } from 'vitest';
import { redactRequestPath } from './app.ts';
import { generateBackupCode } from './routes/mfa.ts';
import { generateTotpSecret, totpCode, verifyTotp } from './lib/totp.ts';

/**
 * Wave-3 audit fixes — pure unit tests (no database): log redaction
 * of token path segments (L-04), backup-code entropy/format (L-05),
 * and TOTP verification after the constant-time change (L-06).
 */

describe('redactRequestPath (L-04)', () => {
  it('redacts the download token path segment', () => {
    const out = redactRequestPath('/api/v1/downloads/super-secret-token-123');
    expect(out).toBe('/api/v1/downloads/[redacted]');
    expect(out).not.toContain('super-secret-token-123');
  });

  it('also drops the query string', () => {
    expect(redactRequestPath('/api/v1/downloads/abc123?next=/me')).toBe('/api/v1/downloads/[redacted]');
    expect(redactRequestPath('/api/v1/auth/verify?token=zzz')).toBe('/api/v1/auth/verify');
  });

  it('passes normal paths through unchanged', () => {
    expect(redactRequestPath('/api/v1/sites/123e4567-e89b-12d3-a456-426614174000')).toBe('/api/v1/sites/123e4567-e89b-12d3-a456-426614174000');
    expect(redactRequestPath('/api/v1/me')).toBe('/api/v1/me');
    expect(redactRequestPath('/api/v1/downloads')).toBe('/api/v1/downloads');
  });
});

describe('generateBackupCode (L-05)', () => {
  it('produces grouped 20-hex-char codes (80 bits of entropy)', () => {
    const codes = Array.from({ length: 100 }, () => generateBackupCode());
    for (const code of codes) {
      expect(code).toMatch(/^([0-9A-F]{5}-){3}[0-9A-F]{5}$/);
      expect(code.replace(/-/g, '')).toHaveLength(20);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('verifyTotp after constant-time change (L-06)', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong)).toBe(false);
    expect(verifyTotp(secret, 'not-a-code')).toBe(false);
  });
});
