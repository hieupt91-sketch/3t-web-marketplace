import { randomBytes } from 'node:crypto';
import { enqueueJob, isUniqueViolation, writeAudit, type Db } from '@3t/core';
import { errors } from './errors.ts';

/**
 * Shared site-creation mechanics (docs/05 C05, docs/12 DEP-06): the buyer's
 * post-purchase wizard (POST /sites) and checkout fulfilment (a hosted order
 * that already carries a chosen subdomain) create sites through this one
 * path, so quota, hold and provisioning rules can never drift apart.
 */

export const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const RESERVED_SUBDOMAINS = new Set(['admin', 'api', 'app', 'www', 'support', 'billing', 'static', 'preview', 'demo', 'mail', 'ftp', 'ns1', 'ns2', 'portal', 'account', 'auth', 'login', 'checkout', 'cdn', 'assets', 'root', 'system']);

type QueryClient = Pick<Db, 'query'>;

export interface HoldRow { id: string; user_id: string; expires_at: Date }

/** The active hold for a name, lazily expiring it when its TTL has passed. */
export async function currentHold(client: QueryClient, subdomain: string): Promise<HoldRow | null> {
  const { rows } = await client.query<HoldRow>(
    "SELECT id, user_id, expires_at FROM subdomain_reservations WHERE subdomain = $1 AND status = 'active'",
    [subdomain],
  );
  const hold = rows[0];
  if (!hold) return null;
  if (new Date(hold.expires_at).getTime() <= Date.now()) {
    await client.query("UPDATE subdomain_reservations SET status = 'expired' WHERE id = $1 AND status = 'active'", [hold.id]);
    return null;
  }
  return hold;
}

export async function enqueueSiteJob(db: QueryClient, type: string, siteId: string, payload: Record<string, unknown>, ownerId: string) {
  const { job } = await enqueueJob(db as Parameters<typeof enqueueJob>[0], {
    type,
    dedupeKey: `${type}:${siteId}:${Date.now()}:${randomBytes(4).toString('hex')}`,
    payload: { site_id: siteId, ...payload },
    resourceType: 'site',
    resourceId: siteId,
    ownerId,
  });
  return job;
}

export interface CreateSiteInput {
  ownerId: string;
  entitlementId: string;
  displayName: string;
  subdomain: string;
  defaultLocale?: 'vi' | 'en';
  demoSessionId?: string | null;
  traceId: string;
  actorType: 'user' | 'system';
  actorId: string | null;
  /** Marks where the create came from ('checkout' for fulfilment auto-create). */
  via?: string;
}

/**
 * Create a site for a hosted entitlement inside the caller's transaction:
 * locks the entitlement (AT-22 quota), honours DEP-06 holds, inserts the
 * site + owner membership, consumes the creator's hold and enqueues the
 * provision job + deployment row. Throws the platform's typed errors
 * (notFound / conflict) exactly like the POST /sites route always did.
 */
export async function createSiteInTx(client: QueryClient, input: CreateSiteInput): Promise<{ siteId: string; jobId: string; deploymentId: string }> {
  const ent = await client.query<{ id: string; user_id: string; template_id: string; version_id: string; mode: string; status: string; instance_limit: number }>(
    'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
    [input.entitlementId],
  );
  const e = ent.rows[0];
  if (!e || e.user_id !== input.ownerId) throw errors.notFound();
  if (e.mode !== 'hosted' || e.status !== 'active') throw errors.conflict('site.entitlement_not_hosted');
  const used = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM sites WHERE entitlement_id = $1 AND status NOT IN ('purged')",
    [input.entitlementId],
  );
  if (Number(used.rows[0]!.n) >= e.instance_limit) throw errors.conflict('site.quota_exceeded');
  let demoSessionId: string | null = null;
  if (input.demoSessionId) {
    const demo = await client.query<{ version_id: string; status: string }>('SELECT version_id, status FROM demo_sessions WHERE id = $1', [input.demoSessionId]);
    if (!demo.rows[0] || demo.rows[0]!.status !== 'active' || demo.rows[0]!.version_id !== e.version_id) throw errors.conflict('site.demo_mismatch');
    demoSessionId = input.demoSessionId;
  }
  // DEP-06: a live hold by another customer blocks the create even when
  // both customers passed the availability check earlier (UX-12); the
  // creator's own hold is consumed below.
  const hold = await currentHold(client, input.subdomain);
  if (hold && hold.user_id !== input.ownerId) throw errors.conflict('site.subdomain_held');
  let site: { id: string };
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sites (owner_id, entitlement_id, template_version_id, display_name, subdomain, default_locale, demo_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.ownerId, input.entitlementId, e.version_id, input.displayName, input.subdomain, input.defaultLocale ?? 'vi', demoSessionId],
    );
    site = inserted.rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) throw errors.conflict('site.subdomain_taken');
    throw error;
  }
  await client.query("INSERT INTO site_members (site_id, user_id, role) VALUES ($1, $2, 'owner')", [site.id, input.ownerId]);
  if (hold) await client.query("UPDATE subdomain_reservations SET status = 'consumed' WHERE id = $1 AND status = 'active'", [hold.id]);
  const job = await enqueueSiteJob(client, 'site.provision', site.id, {}, input.ownerId);
  const dep = await client.query<{ id: string }>(
    "INSERT INTO deployments (site_id, version_id, artifact_id, operation, status, job_id) SELECT $1, $2, artifact_id, 'provision', 'pending', $3 FROM template_versions WHERE id = $2 RETURNING id",
    [site.id, e.version_id, job.id],
  );
  await client.query('UPDATE jobs SET payload_json = payload_json || $2::jsonb WHERE id = $1', [job.id, JSON.stringify({ deployment_id: dep.rows[0]!.id })]);
  await writeAudit(client as Parameters<typeof writeAudit>[0], {
    actorType: input.actorType,
    actorId: input.actorId,
    action: 'site.created',
    resourceType: 'site',
    resourceId: site.id,
    traceId: input.traceId,
    diff: { subdomain: input.subdomain, ...(input.via ? { via: input.via } : {}) },
  });
  return { siteId: site.id, jobId: job.id, deploymentId: dep.rows[0]!.id };
}
