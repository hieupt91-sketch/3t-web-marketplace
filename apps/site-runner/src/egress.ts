/**
 * nftables egress control for site processes (sandbox Phase 1, audit C-01,
 * impl contract §"Runner internals"). PURE builder — unit-tested; at boot
 * the runner applies the script with `nft -f -` when RUNNER_EGRESS=on and
 * verifies the table exists afterwards (fail-closed).
 *
 * Rule order is the security property (per site UID):
 *   established/related → DNS to Docker's embedded resolver → DNS anywhere
 *   → drop loopback → drop private/link-local/CGNAT/multicast → accept
 *   public TCP 443 → drop IPv6 private → drop everything else.
 * DNS precedes the loopback drop (127.0.0.11 sits inside 127.0.0.0/8) and
 * the private drops precede the 443 accept, so 443 reaches public
 * addresses only. The chain policy stays `accept`: non-site traffic on the
 * host is untouched; site UIDs fall through to the final explicit drop.
 */

export const EGRESS_TABLE = 'site_egress';

/**
 * Compress a UID list into nft set elements:
 * [3, 1, 2, 5, 7, 8] → ['1-3', '5', '7-8']. (The runner's full pool —
 * 19998, 19999, 20000..20499 — is one consecutive run, so it compresses
 * to the single interval '19998-20499'.)
 */
export function compressUidRanges(uids: number[]): string[] {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  const flush = () => {
    if (start === undefined || prev === undefined) return;
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = undefined;
    prev = undefined;
  };
  for (const uid of sorted) {
    if (start === undefined || prev === undefined) {
      start = uid;
      prev = uid;
      continue;
    }
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    flush();
    start = uid;
    prev = uid;
  }
  flush();
  return out;
}

export function buildEgressScript(uids: number[]): string {
  const elements = compressUidRanges(uids).join(', ');
  const rule = (body: string) => `        meta skuid @site_uids ${body}`;
  const lines = [
    `table inet ${EGRESS_TABLE} {`,
    '    set site_uids {',
    '        type uid',
    '        flags interval',
    `        elements = { ${elements} }`,
    '    }',
    '    chain out {',
    '        type filter hook output priority 0; policy accept;',
    rule('ct state established,related accept'),
    rule('udp dport 53 ip daddr 127.0.0.11 accept'),
    rule('tcp dport 53 ip daddr 127.0.0.11 accept'),
    rule('udp dport 53 accept'),
    rule('tcp dport 53 accept'),
    rule('ip daddr 127.0.0.0/8 drop'),
    rule('ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 224.0.0.0/4 } drop'),
    rule('tcp dport 443 accept'),
    rule('ip6 daddr { ::1, fe80::/10, fc00::/7 } drop'),
    rule('drop'),
    '    }',
    '}',
    '',
  ];
  return lines.join('\n');
}
