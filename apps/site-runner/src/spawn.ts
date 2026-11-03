/**
 * Process spawn/health/kill primitives for the runner — logic mirrors
 * apps/worker/src/runtime-agent.ts (sandbox Phase 0) so local mode and
 * runner mode behave identically: prlimit wrap (the wrapped process keeps
 * the recorded pid), detached spawn, piped+drained stdio, health loop
 * 20×500 ms against 127.0.0.1, SIGTERM → SIGKILL after 2 s.
 *
 * One deliberate difference: the child env is EXACTLY the validated request
 * env (the worker builds it with its own buildChildEnv allowlist) — the
 * runner adds nothing of its own except PORT, which it always sets from
 * the allocated port, overriding any PORT the request carried.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'serve-dir.mjs');

export interface SpawnLimits {
  cpuSeconds: number;
  addressSpaceMb: number;
  maxProcesses: number;
  fileSizeMb: number;
}

export interface SpawnSpec {
  kind: 'static' | 'runtime';
  dir: string;
  start?: string[];
  healthPath: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
  limits: SpawnLimits;
}

export interface SpawnHandle {
  port: number;
  pid: number;
  limitsApplied: boolean;
  uidApplied: boolean;
  proc: ChildProcess;
}

export class HealthFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealthFailedError';
  }
}

/** SIGTERM now, SIGKILL after 2 s — the worker's killPid semantics. */
export function killPid(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 2000).unref?.();
  } catch {
    /* gone */
  }
}

export async function httpStatus(port: number, path: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolvePromise(0));
  });
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePromise(port));
    });
  });
}

const PRLIMIT = '/usr/bin/prlimit';
let prlimitAvailable: boolean | null = null;

/** Pure argv construction for the prlimit wrapper (same as the worker's). */
export function prlimitArgs(limits: SpawnLimits): string[] {
  return [
    `--cpu=${limits.cpuSeconds}`,
    `--as=${limits.addressSpaceMb * 1024 * 1024}`,
    `--nproc=${limits.maxProcesses}`,
    `--fsize=${limits.fileSizeMb * 1024 * 1024}`,
  ];
}

export function buildLimitedArgv(argv: string[], limits: SpawnLimits, available: boolean): { argv: string[]; applied: boolean } {
  if (!available) return { argv, applied: false };
  // prlimit sets the limits and then execs the program, so the wrapped
  // process keeps the same pid the caller records.
  return { argv: [PRLIMIT, ...prlimitArgs(limits), '--', ...argv], applied: true };
}

export function wrapWithLimits(argv: string[], limits: SpawnLimits): { argv: string[]; applied: boolean } {
  if (prlimitAvailable === null) prlimitAvailable = existsSync(PRLIMIT);
  return buildLimitedArgv(argv, limits, prlimitAvailable);
}

export interface SpawnDeps {
  /** UID/GID application is only attempted when this returns true (root). */
  isRoot: () => boolean;
  log: (event: Record<string, unknown>) => void;
}

/**
 * Spawn a site server and wait for health. Throws HealthFailedError on
 * failure (the half-started child is killed first).
 */
export async function spawnServerLocal(spec: SpawnSpec, deps: SpawnDeps): Promise<SpawnHandle> {
  const port = await freePort();
  const rawArgv = spec.kind === 'static' ? [process.execPath, SERVE_DIR, spec.dir] : spec.start!;
  const wrapped = wrapWithLimits(rawArgv, spec.limits);
  const argv = wrapped.argv;
  if (!wrapped.applied) deps.log({ event: 'runner_prlimit_missing', path: PRLIMIT });

  // setuid spawn is only possible (and only attempted) when the runner
  // itself runs as root AND the request carries a uid; otherwise the
  // child keeps the runner's own uid (dev/show-env) and the caller is
  // told via uidApplied.
  const uidApplied = spec.uid !== undefined && deps.isRoot();
  if (spec.uid !== undefined && !uidApplied) deps.log({ event: 'runner_uid_not_applied', uid: spec.uid, euid: process.getuid?.() ?? -1 });

  const proc: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd: spec.dir,
    // Exactly the request env — except PORT, which the runner owns.
    env: { ...spec.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(uidApplied ? { uid: spec.uid, gid: spec.gid } : {}),
  });
  proc.stdout?.on('data', () => undefined);
  proc.stderr?.on('data', () => undefined);

  let ok = false;
  for (let attempt = 0; attempt < 20 && !ok; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (proc.exitCode !== null) break;
    ok = (await httpStatus(port, spec.healthPath)) === 200;
  }
  if (!ok) {
    killPid(proc.pid ?? null);
    throw new HealthFailedError(`site server failed health at ${spec.healthPath}`);
  }
  return { port, pid: proc.pid ?? 0, limitsApplied: wrapped.applied, uidApplied, proc };
}
