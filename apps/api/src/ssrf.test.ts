import { describe, expect, it } from 'vitest';
import { isPublicIp, resolvePublicAddresses, SsrfError } from './lib/ssrf.ts';

/**
 * Audit M-01/M-02 regression: the shared SSRF guard must reject the full
 * non-public range set — most importantly the link-local cloud-metadata
 * range 169.254.0.0/16 that the old per-call-site lists missed — plus
 * CGNAT, benchmarking, IETF-assignment ranges and IPv4-mapped IPv6.
 */
describe('isPublicIp', () => {
  it('accepts ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '198.20.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it('rejects every non-public IPv4 range', () => {
    for (const ip of [
      '0.0.0.0', '0.1.2.3', // 0.0.0.0/8
      '10.0.0.1', '10.255.255.255', // private
      '100.64.0.1', '100.127.255.255', // CGNAT 100.64.0.0/10
      '127.0.0.1', '127.1.2.3', // loopback
      '169.254.169.254', '169.254.0.1', // link-local / metadata
      '172.16.0.1', '172.31.255.255', // private
      '192.0.0.1', '192.0.0.255', // 192.0.0.0/24
      '192.168.1.1', // private
      '198.18.0.1', '198.19.255.255', // benchmarking 198.18.0.0/15
      '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255', // multicast/reserved
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('rejects non-public IPv6 and IPv4-mapped forms', () => {
    for (const ip of [
      '::1', '::',
      'fc00::1', 'fd12:3456::1', // ULA
      'fe80::1', 'fe9a::1', 'febf::1', // link-local
      'ff02::1', // multicast
      '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::ffff:169.254.169.254', // mapped private
      '::ffff:7f00:1', // mapped 127.0.0.1 in hex form
      '0:0:0:0:0:ffff:192.168.0.1', // expanded mapped form
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true); // mapped public stays public
  });

  it('rejects garbage', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
    expect(isPublicIp('')).toBe(false);
    expect(isPublicIp('999.1.1.1')).toBe(false);
  });
});

describe('resolvePublicAddresses', () => {
  it('rejects private IP literals without a DNS lookup', async () => {
    await expect(resolvePublicAddresses('169.254.169.254', false)).rejects.toMatchObject({ code: 'private_host' });
    await expect(resolvePublicAddresses('127.0.0.1', false)).rejects.toMatchObject({ code: 'private_host' });
    await expect(resolvePublicAddresses('::ffff:10.1.2.3', false)).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows loopback literals only when explicitly enabled', async () => {
    await expect(resolvePublicAddresses('127.0.0.1', true)).resolves.toEqual(['127.0.0.1']);
  });

  it('accepts public IP literals', async () => {
    await expect(resolvePublicAddresses('8.8.8.8', false)).resolves.toEqual(['8.8.8.8']);
  });
});
