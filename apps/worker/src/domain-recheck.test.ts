import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@3t/core';
import { revalidateVerifiedDomains, type TxtResolver } from './order-jobs.js';

/**
 * Audit payments L6: verified custom domains are re-checked against the
 * `_3t-verify` TXT record by the worker sweep. A definitive failure
 * (record gone / token mismatch) starts a 7-day grace; only a failure
 * older than the grace takes the domain out of 'verified'. Transient
 * DNS errors are inconclusive: they never touch the grace state, but
 * they do advance last_recheck_at so the domain is not retried on every
 * sweep pass. Fake Db + fake resolver: no real DNS, no real database.
 */
const TOKEN = 'verify-token-abc';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const NOW = new Date('2026-11-03T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

interface FakeDomain {
  id: string;
  hostname_ascii: string;
  verification_token_hash: string;
  status: string;
  is_primary: boolean;
  last_recheck_at: Date | null;
  recheck_fail_since: Date | null;
}

function makeDomain(overrides: Partial<FakeDomain> = {}): FakeDomain {
  return {
    id: 'dom-1',
    hostname_ascii: 'shop.example.com',
    verification_token_hash: TOKEN_HASH,
    status: 'verified',
    is_primary: true,
    last_recheck_at: null,
    recheck_fail_since: null,
    ...overrides,
  };
}

function fakeDb(domains: FakeDomain[], audits: unknown[][] = []): Db {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM domains')) {
      const staleBefore = params[1] as Date;
      const rows = domains.filter(
        (d) => d.status === 'verified' && (d.last_recheck_at === null || d.last_recheck_at <= staleBefore),
      );
      return { rows: rows.map((d) => ({ ...d })), rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    const row = domains.find((d) => d.id === params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    if (sql.includes("status = 'verification_lost'")) {
      row.status = 'verification_lost';
      row.is_primary = false;
      row.last_recheck_at = params[1] as Date;
    } else if (sql.includes('recheck_fail_since = NULL')) {
      row.last_recheck_at = params[1] as Date;
      row.recheck_fail_since = null;
    } else if (sql.includes('COALESCE(recheck_fail_since')) {
      row.last_recheck_at = params[1] as Date;
      row.recheck_fail_since = row.recheck_fail_since ?? (params[1] as Date);
    } else if (sql.includes('SET last_recheck_at')) {
      // Inconclusive stamp: only the recheck position advances.
      row.last_recheck_at = params[1] as Date;
    } else {
      throw new Error(`unhandled update in fake db: ${sql.slice(0, 80)}`);
    }
    return { rows: [], rowCount: 1 };
  };
  return { query } as unknown as Db;
}

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`queryTxt ${code}`), { code });
}

const txtPresent: TxtResolver = async () => [[TOKEN]];
const txtMissing: TxtResolver = async () => {
  throw dnsError('ENODATA');
};
const txtMismatch: TxtResolver = async () => [['some-other-token']];
const txtServfail: TxtResolver = async () => {
  throw dnsError('ESERVFAIL');
};

describe('revalidateVerifiedDomains', () => {
  it('TXT present → stays verified, fail state cleared, recheck stamped', async () => {
    const domain = makeDomain({ recheck_fail_since: new Date(NOW.getTime() - 2 * DAY) });
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtPresent });
    expect(result).toMatchObject({ checked: 1, kept: 1, lost: 0, inconclusive: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toBeNull();
    expect(domain.last_recheck_at).toEqual(NOW);
  });

  it('queries the _3t-verify.<host> name', async () => {
    const domain = makeDomain();
    const names: string[] = [];
    await revalidateVerifiedDomains(fakeDb([domain]), {
      now: NOW,
      resolveTxt: async (name) => {
        names.push(name);
        return [[TOKEN]];
      },
    });
    expect(names).toEqual(['_3t-verify.shop.example.com']);
  });

  it('TXT missing → grace starts, domain still verified', async () => {
    const domain = makeDomain();
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtMissing });
    expect(result).toMatchObject({ checked: 1, graceStarted: 1, lost: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(NOW);
    expect(domain.last_recheck_at).toEqual(NOW);
  });

  it('TXT mismatch counts as a definitive failure (grace starts)', async () => {
    const domain = makeDomain();
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtMismatch });
    expect(result).toMatchObject({ graceStarted: 1, lost: 0, inconclusive: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(NOW);
  });

  it('TXT missing past the 7-day grace → transitioned to verification_lost + audited', async () => {
    const audits: unknown[][] = [];
    const domain = makeDomain({ recheck_fail_since: new Date(NOW.getTime() - 8 * DAY) });
    const result = await revalidateVerifiedDomains(fakeDb([domain], audits), { now: NOW, resolveTxt: txtMissing });
    expect(result).toMatchObject({ checked: 1, lost: 1 });
    expect(domain.status).toBe('verification_lost');
    expect(domain.is_primary).toBe(false);
    expect(audits.length).toBe(1);
    expect(audits[0]).toContain('domain.verification_lost');
  });

  it('TXT missing within grace (fail began 3 days ago) → still verified, fail_since unchanged', async () => {
    const since = new Date(NOW.getTime() - 3 * DAY);
    const domain = makeDomain({ recheck_fail_since: since });
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtMissing });
    expect(result).toMatchObject({ lost: 0, graceStarted: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(since);
  });

  it('DNS SERVFAIL → inconclusive: grace state untouched, but the recheck stamp advances', async () => {
    const failSince = new Date(NOW.getTime() - 30 * DAY);
    const domain = makeDomain({ recheck_fail_since: failSince });
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtServfail });
    expect(result).toMatchObject({ checked: 0, inconclusive: 1, lost: 0, kept: 0 });
    // Even with a fail state far past the grace, an inconclusive pass
    // must never transition the domain or extend/reset the grace clock…
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(failSince);
    // …but last_recheck_at IS stamped, so the row leaves the head of the
    // sweep queue and re-enters on the normal 24h cadence.
    expect(domain.last_recheck_at).toEqual(NOW);
  });

  it('an inconclusive domain is stamped and NOT re-selected on the next pass', async () => {
    const domain = makeDomain();
    const db = fakeDb([domain]);
    let calls = 0;
    const countingServfail: TxtResolver = async () => {
      calls++;
      throw dnsError('ESERVFAIL');
    };
    const first = await revalidateVerifiedDomains(db, { now: NOW, resolveTxt: countingServfail });
    expect(first.inconclusive).toBe(1);
    expect(domain.last_recheck_at).toEqual(NOW);
    const second = await revalidateVerifiedDomains(db, { now: NOW, resolveTxt: countingServfail });
    expect(calls).toBe(1);
    expect(second).toMatchObject({ checked: 0, inconclusive: 0 });
  });

  it('skips domains rechecked recently (24h cadence)', async () => {
    const domain = makeDomain({ last_recheck_at: new Date(NOW.getTime() - 60 * 60 * 1000) });
    let calls = 0;
    const result = await revalidateVerifiedDomains(fakeDb([domain]), {
      now: NOW,
      resolveTxt: async () => {
        calls++;
        return [[TOKEN]];
      },
    });
    expect(calls).toBe(0);
    expect(result.checked).toBe(0);
  });
});

describe('routing extension (target configured)', () => {
  const TARGET = 'customers.webmaket.com';
  const txtOk: TxtResolver = async () => [[TOKEN]];
  const cnameToTarget = async () => [TARGET];
  const cnameGone = async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  };
  const probeOk = async () => 'ok' as const;
  const probeUnreachable = async () => 'unreachable' as const;

  it('TXT ok + CNAME reaches the target → kept', async () => {
    const domain = makeDomain();
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtOk, target: TARGET, resolveCname: cnameToTarget });
    expect(result).toMatchObject({ checked: 1, kept: 1, lost: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toBeNull();
  });

  it('TXT ok + probe ok with no CNAME (flattened apex) → kept', async () => {
    const domain = makeDomain();
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtOk, target: TARGET, resolveCname: cnameGone, probe: probeOk });
    expect(result).toMatchObject({ checked: 1, kept: 1, lost: 0 });
    expect(domain.status).toBe('verified');
  });

  it('TXT ok + routing conclusively gone → grace starts, same as TXT loss', async () => {
    const domain = makeDomain();
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtOk, target: TARGET, resolveCname: cnameGone, probe: probeUnreachable });
    expect(result).toMatchObject({ checked: 1, graceStarted: 1, lost: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(NOW);
  });

  it('TXT ok + routing gone past the grace → verification_lost', async () => {
    const domain = makeDomain({ recheck_fail_since: new Date(NOW.getTime() - 8 * DAY) });
    const result = await revalidateVerifiedDomains(fakeDb([domain]), { now: NOW, resolveTxt: txtOk, target: TARGET, resolveCname: cnameGone, probe: probeUnreachable });
    expect(result).toMatchObject({ checked: 1, lost: 1 });
    expect(domain.status).toBe('verification_lost');
  });

  it('TXT ok + routing inconclusive (DNS weather) → grace state untouched, stamp advances', async () => {
    const failSince = new Date(NOW.getTime() - 30 * DAY);
    const domain = makeDomain({ recheck_fail_since: failSince });
    const result = await revalidateVerifiedDomains(fakeDb([domain]), {
      now: NOW,
      resolveTxt: txtOk,
      target: TARGET,
      resolveCname: async () => {
        throw Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' });
      },
      probe: probeUnreachable,
    });
    expect(result).toMatchObject({ checked: 0, inconclusive: 1, lost: 0, kept: 0 });
    expect(domain.status).toBe('verified');
    expect(domain.recheck_fail_since).toEqual(failSince);
    expect(domain.last_recheck_at).toEqual(NOW);
  });
});
