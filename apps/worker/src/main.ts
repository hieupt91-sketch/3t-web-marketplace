import { randomBytes } from 'node:crypto';
import { IMPORT_JOB_TYPE, LeaseLostError, LocalObjectStore, claimJob, createPool, enqueueJob, loadConfig } from '@3t/core';
import { LEASE_SECONDS, runImportJob } from './import-pipeline.ts';
import { SITE_JOB_TYPES, backfillSandboxFencing, runSiteJob, sweepExpiredReservations } from './site-jobs.ts';
import { DEMO_JOB_TYPES, runDemoJob } from './demo-jobs.ts';
import { probeRunnerHealth, processAgentMode } from './process-agent.ts';
import { logSandboxStatus, reapOrphanProcesses } from './sandbox.ts';
import { expireStalePaymentOrders, refundStuckWalletSales, revalidateVerifiedDomains } from './order-jobs.ts';
import { createChromiumScreenshotter, type Screenshotter } from './screenshots.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl, 5);
const store = new LocalObjectStore(config.storageDir);
const workerId = `worker-${process.pid}-${randomBytes(4).toString('hex')}`;
let screenshotter: Screenshotter | null = null;
if (config.screenshotsEnabled) {
  if (!config.chromiumPath) throw new Error('SCREENSHOTS=on requires CHROMIUM_PATH');
  screenshotter = await createChromiumScreenshotter(config.chromiumPath);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // Finish the current job; an unfinished lease simply expires and another worker reclaims it.
    stopping = true;
  });
}

function logLine(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'worker', worker_id: workerId, event, ...fields }));
}

logLine('started', { screenshots: screenshotter !== null });

// Deploy race: on a fresh stack the migrations may land after this worker
// starts, and every claim until then fails with "relation jobs does not
// exist". Wait for the core tables (bounded — after the deadline the claim
// loop's own retry logging takes over, exactly as before this gate).
{
  const deadline = Date.now() + 120_000;
  let announced = false;
  for (;;) {
    let ready = false;
    try {
      const { rows } = await db.query<{ ready: boolean }>(
        "SELECT to_regclass('public.jobs') IS NOT NULL AND to_regclass('public.sites') IS NOT NULL AS ready",
      );
      ready = rows[0]?.ready === true;
    } catch {
      ready = false;
    }
    if (ready) break;
    if (Date.now() > deadline) {
      logLine('schema_wait_timeout');
      break;
    }
    if (!announced) {
      logLine('waiting_for_schema');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Sandbox Phase 0 (audit C-01): announce the fencing posture before any
// spawn happens. With SANDBOX_UID_MODE=on this throws when the worker is
// not root — refusing to run template code unfenced is the point.
logSandboxStatus(config, logLine);

// Sandbox Phase 1 (audit C-01): announce where template processes will
// live. In remote mode the site-runner owns every spawn/stop; probe it
// once so a misconfigured deploy is loud in the boot log. A failed
// probe does NOT stop the worker — non-template jobs keep flowing and
// template jobs fail individually with the runner's error.
const agentMode = processAgentMode(config);
logLine('worker_process_agent_mode', { mode: agentMode });
if (agentMode === 'remote') {
  const healthy = await probeRunnerHealth(config);
  if (healthy) logLine('worker_process_agent_health_ok', { url: config.runtimeAgentUrl });
  else {
    logLine('worker_process_agent_health_failed', {
      url: config.runtimeAgentUrl,
      error: 'site-runner /healthz unreachable or not ok — template spawns will fail until the runner is up',
    });
  }
}

// Boot backfill: allocate sandbox UIDs + fence the trees of sites that
// predate Phase 0 (their processes pick the UID up at their boot restart
// below, or at their next restart/update).
try {
  const fenced = await backfillSandboxFencing({ config, db });
  if (fenced > 0) logLine('sandbox_backfill_done', { sites: fenced });
} catch (error) {
  logLine('sandbox_backfill_failed', { error: (error as Error).message });
}

// Boot sweep: site servers are children of this process and die with it (and
// with the host). Re-enqueue a restart for every live site so hosted sites
// come back after a worker/VPS reboot without waiting for a visitor; the
// site router's lazy restart covers anything this sweep misses.
try {
  const { rows } = await db.query<{ id: string; owner_id: string }>("SELECT id, owner_id FROM sites WHERE status IN ('active', 'grace')");
  for (const site of rows) {
    await enqueueJob(db, {
      type: 'site.restart',
      dedupeKey: `site.restart:boot:${site.id}:${Math.floor(Date.now() / 3_600_000)}`,
      payload: { site_id: site.id, boot: true },
      resourceType: 'site',
      resourceId: site.id,
      ownerId: site.owner_id,
    });
  }
  if (rows.length > 0) logLine('boot_site_restarts_enqueued', { count: rows.length });
} catch (error) {
  logLine('boot_sweep_failed', { error: (error as Error).message });
}
let lastReservationSweep = 0;
while (!stopping) {
  const job = await claimJob(db, workerId, [IMPORT_JOB_TYPE, ...SITE_JOB_TYPES, ...DEMO_JOB_TYPES], LEASE_SECONDS).catch((error: Error) => {
    logLine('claim_failed', { error: error.message });
    return null;
  });
  if (!job) {
    // DEP-06: release expired subdomain holds about once a minute while
    // idle (boot sweep included via the zero initial timestamp).
    if (Date.now() - lastReservationSweep > 60_000) {
      lastReservationSweep = Date.now();
      await sweepExpiredReservations(db)
        .then((expired) => {
          if (expired > 0) logLine('reservation_sweep', { expired });
        })
        .catch((error: Error) => logLine('reservation_sweep_failed', { error: error.message }));
      await expireStalePaymentOrders(db)
        .then((expired) => {
          if (expired > 0) logLine('order_expiry_sweep', { expired });
        })
        .catch((error: Error) => logLine('order_expiry_sweep_failed', { error: error.message }));
      await refundStuckWalletSales(db)
        .then(({ refunded, reconciled }) => {
          if (refunded > 0 || reconciled > 0) logLine('wallet_sale_sweep', { refunded, reconciled });
        })
        .catch((error: Error) => logLine('wallet_sale_sweep_failed', { error: error.message }));
      // Wave 3 (payments L6): re-validate verified custom domains' TXT
      // records; a token that stays missing past the grace window moves the
      // domain out of 'verified' (the router only serves that status). The
      // sweep self-throttles to domains not conclusively rechecked in 24h.
      await revalidateVerifiedDomains(db, { target: config.customDomainTarget })
        .then((r) => {
          if (r.lost > 0 || r.graceStarted > 0) logLine('domain_recheck_sweep', { ...r });
        })
        .catch((error: Error) => logLine('domain_recheck_sweep_failed', { error: error.message }));
      // Sandbox reaper: stop processes whose DB record says they should
      // no longer exist (expired/cancelled demo sessions, purged sites) —
      // in Phase 1 remote mode the stop is served by the site-runner,
      // which owns the pid namespace the template processes live in.
      await reapOrphanProcesses(db, config)
        .then(({ demos, sites }) => {
          if (demos > 0 || sites > 0) logLine('orphan_reap', { demos, sites });
        })
        .catch((error: Error) => logLine('orphan_reap_failed', { error: error.message }));
    }
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  logLine('job_claimed', { job_id: job.id, type: job.type, attempt: job.attempts });
  try {
    if (job.type === IMPORT_JOB_TYPE) await runImportJob({ config, db, store, screenshotter }, job);
    else if ((DEMO_JOB_TYPES as readonly string[]).includes(job.type)) await runDemoJob({ config, db, store }, job);
    else await runSiteJob({ config, db, store }, job);
    logLine('job_finished', { job_id: job.id });
  } catch (error) {
    // LeaseLostError: another worker owns the job now (fencing); anything else is logged without payload.
    logLine(error instanceof LeaseLostError ? 'lease_lost' : 'job_crashed', { job_id: job.id, error: (error as Error).message });
  }
}
await screenshotter?.close();
await db.end();
logLine('stopped');
