import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, ORIGIN, type TestContext } from './test-helpers.ts';

/**
 * Custom domains: add returns BOTH DNS instructions (TXT + routing target),
 * re-adding the same hostname for the same site rotates the token (the DB
 * stores only a hash, so a lost TXT value can never be re-shown — rotation
 * is the recovery path), another site's hostname stays domain.taken, and
 * verify requires ownership AND routing before the domain goes 'verified'.
 * DNS is stubbed through the domainDns dependency seam — no real lookups.
 */
let ctx: TestContext;
let ownerA: { id: string; cookie: string };
let ownerB: { id: string; cookie: string };
let siteA = '';
let siteB = '';
let versionId = '';

const TARGET = 'customers.webmaket.com';
/** host -> the TXT token currently "published" in the fake DNS zone. */
const publishedTxt = new Map<string, string>();
/** host -> CNAME target currently "published"; absent = ENODATA. */
const publishedCname = new Map<string, string>();
let probeResult: 'ok' | 'wrong' | 'unreachable' = 'unreachable';
/** Call counters on the routing stubs, to prove routing is (not) run. */
let cnameCalls = 0;
let probeCalls = 0;

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { origin: ORIGIN, cookie }, payload: payload as Record<string, unknown> });
const get = (url: string, cookie: string) => ctx.app.inject({ method: 'GET', url, headers: { origin: ORIGIN, cookie } });

interface AddData {
  id: string;
  hostname_ascii: string;
  status: string;
  verification_token?: string;
  txt_name?: string;
  txt_value?: string;
  cname_target?: string;
}

async function addDomain(siteId: string, cookie: string, hostname: string) {
  const res = await post(`/api/v1/sites/${siteId}/domains`, cookie, { hostname });
  return { res, data: (res.json() as { data: AddData }).data };
}

async function domainRow(id: string): Promise<{ status: string; cert_expires_at: string | null }> {
  const { rows } = await ctx.db.query<{ status: string; cert_expires_at: string | null }>('SELECT status, cert_expires_at FROM domains WHERE id = $1', [id]);
  return rows[0]!;
}

async function seedSite(ownerId: string, slug: string, versionId: string): Promise<string> {
  const site = await ctx.db.query<{ id: string }>(
    "INSERT INTO sites (owner_id, template_version_id, display_name, subdomain, status) VALUES ($1, $2, 'Domain Shop', $3, 'active') RETURNING id",
    [ownerId, versionId, slug],
  );
  await ctx.db.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [site.rows[0]!.id, ownerId]);
  return site.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext(
    {},
    {
      domainDns: {
        resolveTxt: async (name: string) => {
          const host = name.replace(/^_3t-verify\./, '');
          const token = publishedTxt.get(host);
          if (!token) throw dnsError('ENOTFOUND');
          return [[token]];
        },
        resolveCname: async (name: string) => {
          cnameCalls++;
          const target = publishedCname.get(name);
          if (!target) throw dnsError('ENODATA');
          return [target];
        },
        probe: async () => {
          probeCalls++;
          return probeResult;
        },
      },
    },
  );
  ownerA = await createUser(ctx, 'domains-a@example.com');
  ownerB = await createUser(ctx, 'domains-b@example.com');

  const template = await ctx.db.query<{ id: string }>(
    "INSERT INTO templates (slug, owner_id, status) VALUES ('domains-shop', $1, 'published') RETURNING id",
    [ownerA.id],
  );
  const artifact = await ctx.db.query<{ id: string }>(
    `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class)
     VALUES ('test/domains.zip', $1, 10, 'application/zip', 'static_site', 'permanent') RETURNING id`,
    ['d'.repeat(64)],
  );
  const version = await ctx.db.query<{ id: string }>(
    `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, status)
     VALUES ($1, '1.0.0', 1, '{"adapter":"node-http","capabilities":["landing"],"locales":{"supported":["vi"]},"export":{"modes":["hosted"]}}'::jsonb, 'node-http', $2, $3, $3, 'published') RETURNING id`,
    [template.rows[0]!.id, 'd'.repeat(64), artifact.rows[0]!.id],
  );
  versionId = version.rows[0]!.id;
  siteA = await seedSite(ownerA.id, 'domains-a', versionId);
  siteB = await seedSite(ownerB.id, 'domains-b', versionId);
});

afterAll(async () => {
  await ctx.close();
});

describe('custom domains — add + instructions', () => {
  const HOST = 'www.alpha-domain.example.com';

  it('add returns the TXT record AND the routing target', async () => {
    const { res, data } = await addDomain(siteA, ownerA.cookie, HOST);
    expect(res.statusCode).toBe(201);
    expect(data.status).toBe('pending');
    expect(data.txt_name).toBe(`_3t-verify.${HOST}`);
    expect(data.txt_value).toBe(data.verification_token);
    expect(data.txt_value).toMatch(/^[0-9a-f]{64}$/);
    expect(data.cname_target).toBe(TARGET);
  });

  it('GET /sites/:id carries custom_domain_target and the pending row', async () => {
    const res = await get(`/api/v1/sites/${siteA}`, ownerA.cookie);
    const body = res.json() as { data: { custom_domain_target: string; domains: Array<{ hostname_ascii: string; status: string }> } };
    expect(body.data.custom_domain_target).toBe(TARGET);
    expect(body.data.domains.find((d) => d.hostname_ascii === HOST)?.status).toBe('pending');
  });

  it("another site claiming the same hostname stays a domain.taken conflict", async () => {
    const res = await post(`/api/v1/sites/${siteB}/domains`, ownerB.cookie, { hostname: HOST });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('domain.taken');
  });
});

describe('custom domains — token rotation on re-add', () => {
  const HOST = 'www.rotate.example.com';

  it('re-adding rotates the token; the old value stops verifying, the new one works', async () => {
    const first = await addDomain(siteA, ownerA.cookie, HOST);
    expect(first.res.statusCode).toBe(201);
    const oldToken = first.data.txt_value!;

    const second = await addDomain(siteA, ownerA.cookie, HOST);
    expect(second.res.statusCode).toBe(200);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.txt_value).toBeTruthy();
    expect(second.data.txt_value).not.toBe(oldToken);
    const newToken = second.data.txt_value!;

    // The buyer's DNS still carries the OLD token → ownership must fail.
    publishedTxt.set(HOST, oldToken);
    publishedCname.set(HOST, TARGET);
    const stale = await post(`/api/v1/sites/${siteA}/domains/${first.data.id}/verify`, ownerA.cookie);
    expect((stale.json() as { data: { verified: boolean; checks: { ownership: boolean } } }).data.checks.ownership).toBe(false);
    expect((await domainRow(first.data.id)).status).toBe('pending');

    // Publishing the NEW token verifies (test fast-forwards the cooldown).
    publishedTxt.set(HOST, newToken);
    await ctx.db.query('UPDATE domains SET last_verify_at = NULL WHERE id = $1', [first.data.id]);
    const fresh = await post(`/api/v1/sites/${siteA}/domains/${first.data.id}/verify`, ownerA.cookie);
    const freshData = (fresh.json() as { data: { verified: boolean; checks: { ownership: boolean; routing: boolean } } }).data;
    expect(freshData).toEqual({ status: 'verified', verified: true, checks: { ownership: true, routing: true } });
  });
});

describe('custom domains — verify requires ownership AND routing', () => {
  it('TXT ok + CNAME chain reaching the target → verified', async () => {
    const HOST = 'www.cname-ok.example.com';
    const { data } = await addDomain(siteA, ownerA.cookie, HOST);
    publishedTxt.set(HOST, data.txt_value!);
    publishedCname.set(HOST, TARGET);
    const res = await post(`/api/v1/sites/${siteA}/domains/${data.id}/verify`, ownerA.cookie);
    expect((res.json() as { data: unknown }).data).toEqual({ status: 'verified', verified: true, checks: { ownership: true, routing: true } });
    const row = await domainRow(data.id);
    expect(row.status).toBe('verified');
    expect(row.cert_expires_at).not.toBeNull();
  });

  it('TXT ok + no CNAME + probe unreachable → stays pending, checks split', async () => {
    const HOST = 'www.no-route.example.com';
    const { data } = await addDomain(siteA, ownerA.cookie, HOST);
    publishedTxt.set(HOST, data.txt_value!);
    probeResult = 'unreachable';
    const res = await post(`/api/v1/sites/${siteA}/domains/${data.id}/verify`, ownerA.cookie);
    expect((res.json() as { data: unknown }).data).toEqual({ status: 'pending', verified: false, checks: { ownership: true, routing: false } });
    expect((await domainRow(data.id)).status).toBe('pending');
    // …and the 1-minute cooldown still applies to the next attempt.
    const again = await post(`/api/v1/sites/${siteA}/domains/${data.id}/verify`, ownerA.cookie);
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('domain.verify_cooldown');
  });

  it('TXT ok + no CNAME + router probe ok (flattened apex) → verified', async () => {
    const HOST = 'www.probe-ok.example.com';
    const { data } = await addDomain(siteA, ownerA.cookie, HOST);
    publishedTxt.set(HOST, data.txt_value!);
    probeResult = 'ok';
    const res = await post(`/api/v1/sites/${siteA}/domains/${data.id}/verify`, ownerA.cookie);
    expect((res.json() as { data: unknown }).data).toEqual({ status: 'verified', verified: true, checks: { ownership: true, routing: true } });
    probeResult = 'unreachable';
  });

  it('TXT wrong → ownership false, stays pending, and routing is NOT probed', async () => {
    const HOST = 'www.wrong-txt.example.com';
    const { data } = await addDomain(siteA, ownerA.cookie, HOST);
    publishedTxt.set(HOST, 'not-the-token');
    publishedCname.set(HOST, TARGET);
    const cnameBefore = cnameCalls;
    const probeBefore = probeCalls;
    const res = await post(`/api/v1/sites/${siteA}/domains/${data.id}/verify`, ownerA.cookie);
    const body = (res.json() as { data: { verified: boolean; checks: { ownership: boolean; routing: boolean } } }).data;
    expect(body.verified).toBe(false);
    // Routing reports false because it never ran: probing an unowned
    // hostname would resolve/fetch an arbitrary public host for anyone.
    expect(body.checks).toEqual({ ownership: false, routing: false });
    expect(cnameCalls).toBe(cnameBefore);
    expect(probeCalls).toBe(probeBefore);
    expect((await domainRow(data.id)).status).toBe('pending');
  });
});

interface ErrBody {
  error: { code: string; field_errors: Array<{ field: string; code: string }> };
}

describe('custom domains — hostname validation + platform domains', () => {
  const expectRejected = async (hostname: string, code: string) => {
    const res = await post(`/api/v1/sites/${siteB}/domains`, ownerB.cookie, { hostname });
    expect(res.statusCode).toBe(422);
    const body = res.json() as ErrBody;
    expect(body.error.code).toBe('validation.failed');
    expect(body.error.field_errors).toEqual([{ field: 'hostname', code }]);
  };

  it('rejects the platform site base domain and its subdomains', async () => {
    await expectRejected('sites.localhost', 'platform_domain');
    await expectRejected('www.sites.localhost', 'platform_domain');
  });

  it('rejects the preview base domain and its subdomains (pre-existing rule)', async () => {
    await expectRejected('preview.localhost', 'platform_domain');
    await expectRejected('cdn.preview.localhost', 'platform_domain');
  });

  it('rejects malformed hostnames the loose check used to accept', async () => {
    await expectRejected('a..b.com', 'invalid');
    await expectRejected('*.example.com', 'invalid');
    await expectRejected('bad_label.example.com', 'invalid');
    await expectRejected(`${'a'.repeat(64)}.example.com`, 'invalid');
    await expectRejected('-leading.example.com', 'invalid');
    await expectRejected('1.2.3.4', 'invalid');
  });

  it('accepts a trailing dot and normalizes case before storage', async () => {
    const dotted = await addDomain(siteB, ownerB.cookie, 'www.trailing.example.com.');
    expect(dotted.res.statusCode).toBe(201);
    expect(dotted.data.hostname_ascii).toBe('www.trailing.example.com');
    const shouty = await addDomain(siteB, ownerB.cookie, 'Shop.MixedCase.example.com');
    expect(shouty.res.statusCode).toBe(201);
    expect(shouty.data.hostname_ascii).toBe('shop.mixedcase.example.com');
  });
});

describe('custom domains — pending cap', () => {
  it('caps pending domains at 10 per site; rotation at the cap still works', async () => {
    const siteCap = await seedSite(ownerA.id, 'domains-cap', versionId);
    for (let i = 0; i < 10; i++) {
      const { res } = await addDomain(siteCap, ownerA.cookie, `cap-${i}.example.com`);
      expect(res.statusCode).toBe(201);
    }
    const eleventh = await post(`/api/v1/sites/${siteCap}/domains`, ownerA.cookie, { hostname: 'cap-10.example.com' });
    expect(eleventh.statusCode).toBe(409);
    expect((eleventh.json() as { error: { code: string } }).error.code).toBe('domain.pending_limit');
    // Re-adding an existing pending hostname rotates its token instead
    // of creating a row, so it stays available at the cap.
    const readd = await addDomain(siteCap, ownerA.cookie, 'cap-0.example.com');
    expect(readd.res.statusCode).toBe(200);
  });
});

describe('custom domains — verify abuse guards', () => {
  it('token rotation does NOT reset the verify cooldown', async () => {
    const HOST = 'www.cooldown.example.com';
    const { data } = await addDomain(siteB, ownerB.cookie, HOST);
    // A failed verify stamps last_verify_at and starts the 60s cooldown.
    publishedTxt.set(HOST, 'not-the-token');
    const first = await post(`/api/v1/sites/${siteB}/domains/${data.id}/verify`, ownerB.cookie);
    expect(first.statusCode).toBe(200);
    // Re-adding rotates the token; it must not hand back a fresh verify.
    const readded = await addDomain(siteB, ownerB.cookie, HOST);
    expect(readded.res.statusCode).toBe(200);
    expect(readded.data.txt_value).toBeTruthy();
    expect(readded.data.txt_value).not.toBe(data.txt_value);
    const second = await post(`/api/v1/sites/${siteB}/domains/${data.id}/verify`, ownerB.cookie);
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('domain.verify_cooldown');
  });

  it('verify is rate-limited per account (10/min)', async () => {
    const ownerC = await createUser(ctx, 'domains-c@example.com');
    const siteC = await seedSite(ownerC.id, 'domains-c', versionId);
    const { data } = await addDomain(siteC, ownerC.cookie, 'www.ratelimit.example.com');
    for (let i = 0; i < 10; i++) {
      const res = await post(`/api/v1/sites/${siteC}/domains/${data.id}/verify`, ownerC.cookie);
      expect(res.statusCode).not.toBe(429);
    }
    const eleventh = await post(`/api/v1/sites/${siteC}/domains/${data.id}/verify`, ownerC.cookie);
    expect(eleventh.statusCode).toBe(429);
    expect((eleventh.json() as { error: { code: string } }).error.code).toBe('rate_limit.exceeded');
  });

  it('add-domain is rate-limited per account (30/hour)', async () => {
    const ownerD = await createUser(ctx, 'domains-d@example.com');
    const sites: string[] = [];
    for (let s = 0; s < 4; s++) sites.push(await seedSite(ownerD.id, `domains-d${s}`, versionId));
    // 8 pending per site stays under the per-site cap of 10, so only the
    // per-account rate limit can bite — on the 31st add.
    for (let i = 0; i < 30; i++) {
      const res = await post(`/api/v1/sites/${sites[Math.floor(i / 8)]}/domains`, ownerD.cookie, { hostname: `rl-${i}.example.com` });
      expect(res.statusCode).toBe(201);
    }
    const thirtyFirst = await post(`/api/v1/sites/${sites[3]}/domains`, ownerD.cookie, { hostname: 'rl-30.example.com' });
    expect(thirtyFirst.statusCode).toBe(429);
    expect((thirtyFirst.json() as { error: { code: string } }).error.code).toBe('rate_limit.exceeded');
  });
});

describe('custom domains — verify state guard', () => {
  it('a released domain cannot be resurrected by verify', async () => {
    const HOST = 'www.released.example.com';
    const { data } = await addDomain(siteB, ownerB.cookie, HOST);
    publishedTxt.set(HOST, data.txt_value!);
    publishedCname.set(HOST, TARGET);
    const rel = await post(`/api/v1/sites/${siteB}/domains/${data.id}/release`, ownerB.cookie);
    expect(rel.statusCode).toBe(200);
    const res = await post(`/api/v1/sites/${siteB}/domains/${data.id}/verify`, ownerB.cookie);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('domain.not_verified');
    expect((await domainRow(data.id)).status).toBe('released');
  });

  it('a verification_lost domain can verify again', async () => {
    const HOST = 'www.lost.example.com';
    const { data } = await addDomain(siteB, ownerB.cookie, HOST);
    publishedTxt.set(HOST, data.txt_value!);
    publishedCname.set(HOST, TARGET);
    await ctx.db.query("UPDATE domains SET status = 'verification_lost' WHERE id = $1", [data.id]);
    const res = await post(`/api/v1/sites/${siteB}/domains/${data.id}/verify`, ownerB.cookie);
    expect((res.json() as { data: { status: string; verified: boolean } }).data).toMatchObject({ status: 'verified', verified: true });
    expect((await domainRow(data.id)).status).toBe('verified');
  });
});
