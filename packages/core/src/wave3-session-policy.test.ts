import { describe, expect, it } from 'vitest';
import { loadConfig, sessionLimits, sessionRejectionReason, shouldRefreshLastSeen } from './config.ts';

/**
 * Wave-3 audit L-03 session policy: role-holding sessions 72 h
 * absolute / 12 h idle; plain buyers 168 h / 48 h; throttled
 * last_seen_at refresh. Pure unit tests over the policy helpers.
 */
const config = loadConfig({ env: 'test' });
const H = 3_600_000;
const T0 = new Date('2026-11-03T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);

describe('session policy defaults (L-03)', () => {
  it('ships the documented caps', () => {
    expect(config.sessionRoleTtlHours).toBe(72);
    expect(config.sessionBuyerTtlHours).toBe(168);
    expect(config.sessionRoleIdleHours).toBe(12);
    expect(config.sessionBuyerIdleHours).toBe(48);
  });

  it('picks limits by current role class', () => {
    expect(sessionLimits(config, true)).toEqual({ absoluteTtlHours: 72, idleHours: 12 });
    expect(sessionLimits(config, false)).toEqual({ absoluteTtlHours: 168, idleHours: 48 });
  });
});

describe('sessionRejectionReason (L-03)', () => {
  const staff = sessionLimits(config, true);
  const buyer = sessionLimits(config, false);

  it('rejects a staff session idle past 12 h, keeps one inside it', () => {
    expect(sessionRejectionReason(staff, T0, T0, at(13))).toBe('idle');
    expect(sessionRejectionReason(staff, T0, at(1), at(11))).toBeNull();
  });

  it('rejects a buyer idle at 49 h but not at 47 h', () => {
    expect(sessionRejectionReason(buyer, T0, T0, at(49))).toBe('idle');
    expect(sessionRejectionReason(buyer, T0, T0, at(47))).toBeNull();
  });

  it('enforces the staff absolute cap even for an active session', () => {
    // Created 73 h ago, seen just now: idle is fine, absolute is not.
    expect(sessionRejectionReason(staff, T0, at(73), at(73))).toBe('absolute');
    expect(sessionRejectionReason(staff, T0, at(71), at(71))).toBeNull();
  });

  it('enforces the buyer absolute cap at 168 h', () => {
    expect(sessionRejectionReason(buyer, T0, at(169), at(169))).toBe('absolute');
    expect(sessionRejectionReason(buyer, T0, at(100), at(120))).toBeNull();
  });
});

describe('shouldRefreshLastSeen throttle (L-03)', () => {
  it('does not refresh inside the 5-minute throttle window', () => {
    expect(shouldRefreshLastSeen(T0, new Date(T0.getTime() + 2 * 60_000))).toBe(false);
    expect(shouldRefreshLastSeen(T0, new Date(T0.getTime() + 5 * 60_000))).toBe(false);
  });

  it('refreshes once last_seen_at is older than 5 minutes', () => {
    expect(shouldRefreshLastSeen(T0, new Date(T0.getTime() + 5 * 60_000 + 1))).toBe(true);
    expect(shouldRefreshLastSeen(T0, new Date(T0.getTime() + 60 * 60_000))).toBe(true);
  });
});
