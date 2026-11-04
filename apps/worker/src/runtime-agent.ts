import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlatformConfig } from '@3t/core';

const SERVE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'serve-dir.mjs');

/**
 * Runtime agent (M5, docs/02 §5, docs/08 §9).
 * The API never holds docker.sock and never runs an arbitrary command: every
 * operation goes through this allowlist, and each mutating call carries the
 * site's row_version as a fencing token — a stale caller cannot restart or
 * replace a site that has since changed hands.
 *
 * LocalRuntimeAgent is the dev/local implementation (spawn on this machine).
 * A production remote agent (mTLS + allowlisted commands on a node) implements
 * the same interface; the API and saga code do not depend on the transport.
 */
export type AgentAction = 'restart' | 'suspend' | 'resume';

/** prlimit caps for a spawned template server (sandbox Phase 0, audit C-01). */
export interface SiteLimits {
  cpuSeconds: number;
  addressSpaceMb: number;
  maxProcesses: number;
  fileSizeMb: number;
}

export function siteLimitsOf(config: PlatformConfig): SiteLimits {
  return {
    cpuSeconds: config.siteLimitCpuSeconds,
    addressSpaceMb: config.siteLimitAddressSpaceMb,
    maxProcesses: config.siteLimitMaxProcesses,
    fileSizeMb: config.siteLimitFileSizeMb,
  };
}

export interface SpawnSpec {
  kind: 'static' | 'runtime';
  dir: string;
  /** Runtime start argv (node-http / next-standalone); static uses serve-dir. */
  start?: string[];
  healthPath: string;
  env?: Record<string, string>;
  /**
   * Sandbox Phase 0: run the child under this UID/GID instead of the
   * worker's own. Only honoured when the worker runs as root (production);
   * the sandbox module resolves these and passes none when fencing is off.
   * A different UID is what actually closes the C-01 holes: /proc/<pid>/
   * environ of the platform processes is ptrace-gated by UID, and the
   * fenced site tree (0700, owned by this UID) blocks cross-tenant reads.
   */
  uid?: number;
  gid?: number;
  /** prlimit caps applied to the child at spawn. */
  limits?: SiteLimits;
  /** The child's own writable tree (its data/): exported as HOME + TMPDIR. */
  writableDir?: string;
}

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
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const PRLIMIT = '/usr/bin/prlimit';
let prlimitAvailable: boolean | null = null;

/** Pure argv construction for the prlimit wrapper (unit-tested). */
export function prlimitArgs(limits: SiteLimits): string[] {
  return [
    `--cpu=${limits.cpuSeconds}`,
    `--as=${limits.addressSpaceMb * 1024 * 1024}`,
    `--nproc=${limits.maxProcesses}`,
    `--fsize=${limits.fileSizeMb * 1024 * 1024}`,
  ];
}

export function buildLimitedArgv(argv: string[], limits: SiteLimits, available: boolean): { argv: string[]; applied: boolean } {
  if (!available) return { argv, applied: false };
  // prlimit sets the limits and then execs the program, so the wrapped
  // process keeps the same pid the caller records.
  return { argv: [PRLIMIT, ...prlimitArgs(limits), '--', ...argv], applied: true };
}

export function wrapWithLimits(argv: string[], limits: SiteLimits): { argv: string[]; applied: boolean } {
  if (prlimitAvailable === null) prlimitAvailable = existsSync(PRLIMIT);
  return buildLimitedArgv(argv, limits, prlimitAvailable);
}

/**
 * The child's environment is an ALLOWLIST, never a copy of the worker's:
 * platform secrets (DATABASE_URL, MFA_KEY, …) must never reach template
 * code through env (regression-locked by test; the /proc route is closed
 * separately by the UID split). Only PATH/NODE_ENV/PORT/HOST, the child's
 * own HOME/TMPDIR inside its writable tree, and the manifest's declared
 * `scope:'public'` variables (spec.env) are passed.
 */
export function buildChildEnv(config: PlatformConfig, spec: SpawnSpec, port: number): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: config.runtimeBindHost,
  };
  if (spec.writableDir) {
    env.HOME = spec.writableDir;
    env.TMPDIR = join(spec.writableDir, '.tmp');
  }
  return { ...env, ...(spec.env ?? {}) };
}

/**
 * argv for the bundled static file server. Deliberately 'node' resolved
 * through PATH — never process.execPath: under sandbox fencing the child
 * runs as the site's dedicated UID, and the worker's own node binary may
 * live under a tree that UID cannot traverse (nvm-style homes, private
 * install dirs), which made every static spawn fail its health check.
 * PATH resolution falls through to a reachable node, exactly like the
 * runtime adapters' manifest start commands already do.
 */
export function staticServeArgv(dir: string): string[] {
  return ['node', SERVE_DIR, dir];
}

/** Spawn a site server and wait for health. Throws on failure (caller rolls back). */
export async function spawnServer(config: PlatformConfig, spec: SpawnSpec): Promise<{ port: number; pid: number; limitsApplied: boolean; uidApplied: boolean }> {
  const port = await freePort();
  const rawArgv = spec.kind === 'static' ? staticServeArgv(spec.dir) : spec.start!;
  let argv = rawArgv;
  let limitsApplied = false;
  if (spec.limits) {
    const wrapped = wrapWithLimits(rawArgv, spec.limits);
    argv = wrapped.argv;
    limitsApplied = wrapped.applied;
    if (!limitsApplied) console.warn(JSON.stringify({ event: 'sandbox_prlimit_missing', path: PRLIMIT }));
  }
  // setuid spawn is only possible (and only attempted) when the worker
  // itself runs as root; the sandbox module never hands out a UID in any
  // other mode, so a spec.uid here always pairs with a root worker.
  const uidApplied = spec.uid !== undefined && (process.getuid?.() ?? -1) === 0;
  if (spec.uid !== undefined && !uidApplied) {
    console.warn(JSON.stringify({ event: 'sandbox_uid_not_applied', uid: spec.uid, euid: process.getuid?.() }));
  }
  const proc: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd: spec.dir,
    env: buildChildEnv(config, spec, port),
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
    throw new Error(`site server failed health at ${spec.healthPath}`);
  }
  return { port, pid: proc.pid ?? 0, limitsApplied, uidApplied };
}

/** Atomically swap a site directory: new tree in, old tree kept until success. */
export async function swapDir(siteDir: string, stagedDir: string): Promise<void> {
  const trash = `${siteDir}.old-${Date.now()}`;
  const hasOld = existsSync(siteDir);
  if (hasOld) await rename(siteDir, trash);
  try {
    await rename(stagedDir, siteDir);
  } catch (error) {
    if (hasOld) await rename(trash, siteDir);
    throw error;
  }
  if (hasOld) await rm(trash, { recursive: true, force: true });
}

export async function writeSiteMeta(dir: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'site.json'), JSON.stringify(meta, null, 2));
}

export async function copyTree(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, dereference: false });
}

export { mkdir, rm };
