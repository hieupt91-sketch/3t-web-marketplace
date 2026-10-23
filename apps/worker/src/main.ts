import { randomBytes } from 'node:crypto';
import { IMPORT_JOB_TYPE, LeaseLostError, LocalObjectStore, claimJob, createPool, loadConfig } from '@3t/core';
import { LEASE_SECONDS, runImportJob } from './import-pipeline.ts';
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
while (!stopping) {
  const job = await claimJob(db, workerId, [IMPORT_JOB_TYPE], LEASE_SECONDS).catch((error: Error) => {
    logLine('claim_failed', { error: error.message });
    return null;
  });
  if (!job) {
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  logLine('job_claimed', { job_id: job.id, type: job.type, attempt: job.attempts });
  try {
    await runImportJob({ config, db, store, screenshotter }, job);
    logLine('job_finished', { job_id: job.id });
  } catch (error) {
    // LeaseLostError: another worker owns the job now (fencing); anything else is logged without payload.
    logLine(error instanceof LeaseLostError ? 'lease_lost' : 'job_crashed', { job_id: job.id, error: (error as Error).message });
  }
}
await screenshotter?.close();
await db.end();
logLine('stopped');
