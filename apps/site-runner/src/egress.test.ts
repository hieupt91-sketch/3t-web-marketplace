import { describe, expect, it } from 'vitest';
import { buildEgressScript, compressUidRanges } from './egress.js';
import { siteUidList } from './validate.js';

describe('compressUidRanges', () => {
  it('compresses consecutive runs', () => {
    expect(compressUidRanges([3, 1, 2, 5, 7, 8])).toEqual(['1-3', '5', '7-8']);
  });

  it('dedupes and sorts', () => {
    expect(compressUidRanges([5, 5, 4, 9])).toEqual(['4-5', '9']);
  });

  it('handles empty input', () => {
    expect(compressUidRanges([])).toEqual([]);
  });
});

describe('buildEgressScript', () => {
  const script = buildEgressScript(siteUidList());

  it('defines the inet table, output chain and uid set', () => {
    expect(script).toContain('table inet site_egress');
    expect(script).toContain('type filter hook output priority 0; policy accept;');
    expect(script).toContain('type uid');
    expect(script).toContain('flags interval');
    // Demos (19998), imports (19999) and the site pool (20000-20499) are
    // consecutive, so they compress into a single interval.
    expect(script).toContain('elements = { 19998-20499 }');
  });

  it('guards every rule with the site uid set', () => {
    const actionLines = script
      .split('\n')
      .filter((line) => (line.includes('accept') || line.includes('drop')) && !line.includes('policy'));
    expect(actionLines).toHaveLength(10);
    for (const line of actionLines) expect(line).toContain('meta skuid @site_uids');
  });

  it('emits the required rules in the required order', () => {
    const idx = (needle: string): number => {
      const at = script.indexOf(needle);
      expect(at, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
      return at;
    };
    // 1. established/related first
    const established = idx('ct state established,related accept');
    // 2. DNS to Docker embedded resolver before generic DNS and before loopback drop
    const dockerDns = idx('127.0.0.11');
    const genericDns = idx('udp dport 53 accept');
    // 4. loopback drop AFTER DNS (127.0.0.11 is inside 127.0.0.0/8)
    const loopback = idx('ip daddr 127.0.0.0/8 drop');
    // 5. private drops before the 443 accept
    const privates = idx('169.254.0.0/16');
    const https = idx('tcp dport 443 accept');
    // 7. IPv6 private drop, then 8. the final catch-all drop
    const ip6 = idx('fe80::/10');

    expect(established).toBeLessThan(dockerDns);
    expect(dockerDns).toBeLessThan(genericDns);
    expect(genericDns).toBeLessThan(loopback);
    expect(loopback).toBeLessThan(privates);
    expect(privates).toBeLessThan(https);
    expect(https).toBeLessThan(ip6);
    expect(script.lastIndexOf('meta skuid @site_uids drop')).toBeGreaterThan(ip6);
  });

  it('drops every blocked range from the contract', () => {
    for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '224.0.0.0/4', '127.0.0.0/8', '::1', 'fe80::/10', 'fc00::/7']) {
      expect(script, range).toContain(range);
    }
  });
});
