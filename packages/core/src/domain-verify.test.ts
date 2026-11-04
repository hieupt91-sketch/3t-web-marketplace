import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkCnameChain,
  checkDomainOwnership,
  checkDomainRouting,
  domainTxtRecordsMatch,
  isPublicAddress,
  probeDomainRouting,
  type CnameResolver,
  type RoutingProbe,
  type TxtResolver,
} from './domain-verify.ts';

const TOKEN = 'tok-123';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const TARGET = 'customers.webmaket.com';

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`dns ${code}`), { code });
}

describe('domainTxtRecordsMatch / checkDomainOwnership', () => {
  it('matches a token spread across TXT chunks', () => {
    expect(domainTxtRecordsMatch([['other'], [TOKEN]], TOKEN_HASH)).toBe(true);
    expect(domainTxtRecordsMatch([['other']], TOKEN_HASH)).toBe(false);
  });

  it('reads _3t-verify.<host> and fails closed on resolver errors', async () => {
    const seen: string[] = [];
    const ok: TxtResolver = async (name) => {
      seen.push(name);
      return [[TOKEN]];
    };
    await expect(checkDomainOwnership('Shop.Example.com.', TOKEN_HASH, ok)).resolves.toBe(true);
    expect(seen).toEqual(['_3t-verify.shop.example.com']);
    const boom: TxtResolver = async () => {
      throw dnsError('ESERVFAIL');
    };
    await expect(checkDomainOwnership('shop.example.com', TOKEN_HASH, boom)).resolves.toBe(false);
  });
});

describe('checkCnameChain', () => {
  it('reaches the target directly and through hops (case/trailing-dot insensitive)', async () => {
    const direct: CnameResolver = async () => ['Customers.Webmaket.com.'];
    await expect(checkCnameChain('shop.example.com', TARGET, direct)).resolves.toEqual({ reached: true, conclusive: true });
    const hops: CnameResolver = async (name) => (name === 'shop.example.com' ? ['edge.provider.net'] : ['customers.webmaket.com']);
    await expect(checkCnameChain('shop.example.com', TARGET, hops)).resolves.toEqual({ reached: true, conclusive: true });
  });

  it('a chain ending in ENODATA/ENOTFOUND is a conclusive miss; SERVFAIL is weather', async () => {
    const noData: CnameResolver = async () => {
      throw dnsError('ENODATA');
    };
    await expect(checkCnameChain('example.com', TARGET, noData)).resolves.toEqual({ reached: false, conclusive: true });
    const servfail: CnameResolver = async () => {
      throw dnsError('ESERVFAIL');
    };
    await expect(checkCnameChain('shop.example.com', TARGET, servfail)).resolves.toEqual({ reached: false, conclusive: false });
  });

  it('stops at the hop budget without a conclusive verdict', async () => {
    let n = 0;
    const loop: CnameResolver = async () => [`hop-${n++}.example.net`];
    await expect(checkCnameChain('shop.example.com', TARGET, loop, 3)).resolves.toEqual({ reached: false, conclusive: false });
    expect(n).toBe(3);
  });
});

describe('probeDomainRouting', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('ok only on status 200 with the exact marker body', async () => {
    await expect(
      probeDomainRouting('shop.example.com', { lookupAll: publicLookup, httpGet: async () => ({ status: 200, body: '3t-router-ok' }) }),
    ).resolves.toBe('ok');
    await expect(
      probeDomainRouting('shop.example.com', { lookupAll: publicLookup, httpGet: async () => ({ status: 200, body: 'hello' }) }),
    ).resolves.toBe('wrong');
    await expect(
      probeDomainRouting('shop.example.com', { lookupAll: publicLookup, httpGet: async () => ({ status: 404, body: '3t-router-ok' }) }),
    ).resolves.toBe('wrong');
  });

  it('tries every resolved address in order until one proves the router', async () => {
    const twoAddresses = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];
    // First address answers, but not the router; the second proves it.
    await expect(
      probeDomainRouting('shop.example.com', {
        lookupAll: twoAddresses,
        httpGet: async (address) => (address.endsWith('.35') ? { status: 200, body: '3t-router-ok' } : { status: 200, body: 'someone-else' }),
      }),
    ).resolves.toBe('ok');
    // A dead transport on the first address does not end the search either.
    await expect(
      probeDomainRouting('shop.example.com', {
        lookupAll: twoAddresses,
        httpGet: async (address) => {
          if (address.endsWith('.34')) throw new Error('ECONNREFUSED');
          return { status: 200, body: '3t-router-ok' };
        },
      }),
    ).resolves.toBe('ok');
    // No ok anywhere: answered-but-wrong beats unreachable, and
    // all-transport-failures stays unreachable.
    await expect(
      probeDomainRouting('shop.example.com', {
        lookupAll: twoAddresses,
        httpGet: async (address) => {
          if (address.endsWith('.34')) throw new Error('ECONNREFUSED');
          return { status: 404, body: 'nope' };
        },
      }),
    ).resolves.toBe('wrong');
    await expect(
      probeDomainRouting('shop.example.com', {
        lookupAll: twoAddresses,
        httpGet: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).resolves.toBe('unreachable');
  });

  it('refuses private/loopback resolutions and treats lookup/HTTP failures as unreachable', async () => {
    const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(
      probeDomainRouting('sneaky.example.com', {
        lookupAll: privateLookup,
        httpGet: async () => {
          throw new Error('must not be called');
        },
      }),
    ).resolves.toBe('unreachable');
    await expect(
      probeDomainRouting('down.example.com', {
        lookupAll: async () => {
          throw dnsError('ENOTFOUND');
        },
      }),
    ).resolves.toBe('unreachable');
    await expect(
      probeDomainRouting('down.example.com', {
        lookupAll: publicLookup,
        httpGet: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).resolves.toBe('unreachable');
  });
});

describe('checkDomainRouting', () => {
  it('CNAME reaching the target is proof — the probe is never consulted', async () => {
    let probed = false;
    const probe: RoutingProbe = async () => {
      probed = true;
      return 'unreachable';
    };
    const res = await checkDomainRouting('shop.example.com', TARGET, { resolveCname: async () => [TARGET], probe });
    expect(res).toEqual({ ok: true, conclusive: true });
    expect(probed).toBe(false);
  });

  it('probe ok verifies flattened/proxied setups the chain cannot see', async () => {
    const res = await checkDomainRouting('example.com', TARGET, {
      resolveCname: async () => {
        throw dnsError('ENODATA');
      },
      probe: async () => 'ok',
    });
    expect(res).toEqual({ ok: true, conclusive: true });
  });

  it('a wrong answer is a conclusive failure; unreachable follows chain conclusiveness', async () => {
    const noCname: CnameResolver = async () => {
      throw dnsError('ENODATA');
    };
    await expect(checkDomainRouting('shop.example.com', TARGET, { resolveCname: noCname, probe: async () => 'wrong' })).resolves.toEqual({
      ok: false,
      conclusive: true,
    });
    await expect(checkDomainRouting('shop.example.com', TARGET, { resolveCname: noCname, probe: async () => 'unreachable' })).resolves.toEqual({
      ok: false,
      conclusive: true,
    });
    const servfail: CnameResolver = async () => {
      throw dnsError('ESERVFAIL');
    };
    await expect(checkDomainRouting('shop.example.com', TARGET, { resolveCname: servfail, probe: async () => 'unreachable' })).resolves.toEqual({
      ok: false,
      conclusive: false,
    });
  });
});

describe('isPublicAddress', () => {
  it('accepts public addresses and rejects private/reserved/mapped ones', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
    for (const bad of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
      expect(isPublicAddress(bad)).toBe(false);
    }
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true);
    // Expanded (uncompressed) IPv4-mapped forms are unwrapped too: the
    // embedded IPv4 decides, in dotted and hex-pair spellings alike.
    expect(isPublicAddress('0:0:0:0:0:ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('0:0:0:0:0:ffff:7f00:1')).toBe(false);
    expect(isPublicAddress('0:0:0:0:0:ffff:10.0.0.9')).toBe(false);
    expect(isPublicAddress('0:0:0:0:0:ffff:93.184.216.34')).toBe(true);
  });
});
