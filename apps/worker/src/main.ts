import { randomBytes } from 'node:crypto';
import { IMPORT_JOB_TYPE, LeaseLostError, LocalObjectStore, claimJob, createPool, enqueueJob, loadConfig } from '@3t/core';
import { LEASE_SECONDS, runImportJob } from './import-pipeline.ts';
import { SITE_JOB_TYPES, runSiteJob, sweepExpiredReservations } from './site-jobs.ts';
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
  const job = await claimJob(db, workerId, [IMPORT_JOB_TYPE, ...SITE_JOB_TYPES], LEASE_SECONDS).catch((error: Error) => {
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
    }
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  logLine('job_claimed', { job_id: job.id, type: job.type, attempt: job.attempts });
  try {
    if (job.type === IMPORT_JOB_TYPE) await runImportJob({ config, db, store, screenshotter }, job);
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
