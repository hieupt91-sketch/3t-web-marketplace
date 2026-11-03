/**
 * Site-runner entry point (sandbox Phase 1, audit C-01).
 *
 * This process is the ONLY spawner of template code in runner mode. It
 * holds NO platform credentials: its env is RUNNER_TOKEN + its own
 * RUNNER_* settings, nothing else (probe P7). It refuses to start without
 * a token or a work root — fail-closed, like everything else here.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEgressScript, EGRESS_TABLE } from './egress.js';
import { createRunnerServer } from './server.js';
import { RunnerService, type LogFn } from './service.js';
import { siteUidList } from './validate.js';

const log: LogFn = (event) => console.log(JSON.stringify(event));

export interface RunnerConfig {
  token: string;
  port: number;
  workRoot: string;
  siteGid: number;
  egressOn: boolean;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const token = env.RUNNER_TOKEN ?? '';
  if (!token) throw new Error('RUNNER_TOKEN is not set — refusing to start');
  const workRootRaw = env.RUNNER_WORK_ROOT ?? '';
  if (!workRootRaw) throw new Error('RUNNER_WORK_ROOT is not set — refusing to start');
  const port = Number(env.RUNNER_PORT ?? '4300');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`RUNNER_PORT must be an integer in 1..65535, got ${JSON.stringify(env.RUNNER_PORT)}`);
  }
  const siteGid = Number(env.RUNNER_SITE_GID ?? '19990');
  if (!Number.isInteger(siteGid) || siteGid < 1) {
    throw new Error(`RUNNER_SITE_GID must be a positive integer, got ${JSON.stringify(env.RUNNER_SITE_GID)}`);
  }
  return {
    token,
    port,
    workRoot: resolve(workRootRaw),
    siteGid,
    // Egress is opt-in per environment: anything but an explicit 'on'
    // (dev, show-env) leaves host firewall state untouched.
    egressOn: env.RUNNER_EGRESS === 'on',
  };
}

/**
 * Apply the egress ruleset and verify it landed. Any failure throws — the
 * caller exits non-zero rather than run sites without egress control
 * (fail-closed).
 */
export function applyEgress(uids: number[]): void {
  const script = buildEgressScript(uids);
  execFileSync('nft', ['-f', '-'], { input: script, encoding: 'utf8' });
  const ruleset = execFileSync('nft', ['list', 'ruleset'], { encoding: 'utf8' });
  if (!ruleset.includes(EGRESS_TABLE)) {
    throw new Error(`egress verification failed: table ${EGRESS_TABLE} missing after apply`);
  }
}

export function startRunner(config: RunnerConfig): { service: RunnerService; server: ReturnType<typeof createRunnerServer> } {
  if (config.egressOn) {
    applyEgress(siteUidList());
    log({ event: 'runner_egress_applied', table: EGRESS_TABLE });
  } else {
    log({ event: 'runner_egress_off', severity: 'warn' });
  }
  const service = new RunnerService({ workRoot: config.workRoot, log });
  service.boot();
  const server = createRunnerServer(service, { token: config.token, workRoot: config.workRoot, siteGid: config.siteGid, log });
  server.listen(config.port, () => {
    log({ event: 'runner_listening', port: config.port, workRoot: config.workRoot });
  });
  return { service, server };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const config = loadRunnerConfig(process.env);
    const { service, server } = startRunner(config);
    const shutdown = (signal: string) => {
      log({ event: 'runner_shutdown', signal });
      service.shutdown();
      server.close(() => process.exit(0));
      // Children are detached site processes: they keep running and are
      // re-adopted from the state file on the next boot. Never kill them
      // from a signal handler.
      setTimeout(() => process.exit(0), 3000).unref?.();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error(JSON.stringify({ event: 'runner_fatal', error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}
