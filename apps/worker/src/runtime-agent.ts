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

export interface SpawnSpec {
  kind: 'static' | 'runtime';
  dir: string;
  /** Runtime start argv (node-http / next-standalone); static uses serve-dir. */
  start?: string[];
  healthPath: string;
  env?: Record<string, string>;
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

/** Spawn a site server and wait for health. Throws on failure (caller rolls back). */
export async function spawnServer(config: PlatformConfig, spec: SpawnSpec): Promise<{ port: number; pid: number }> {
  const port = await freePort();
  const argv = spec.kind === 'static' ? [process.execPath, SERVE_DIR, spec.dir] : spec.start!;
  const proc: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    cwd: spec.dir,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', ...(spec.env ?? {}) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  return { port, pid: proc.pid ?? 0 };
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
