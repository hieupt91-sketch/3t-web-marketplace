import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';

export interface ExecutorOptions {
  /** Working directory; the command cannot be given any other cwd. */
  cwd: string;
  /** Wall-clock timeout in ms (default 10 minutes for builds). */
  timeoutMs?: number;
  /** Cap on captured stdout+stderr bytes (default 1 MiB). */
  maxOutputBytes?: number;
  /** Extra environment variables (allowlisted by the caller, never secrets). */
  env?: Record<string, string>;
  /**
   * When false, the command runs in a fresh network namespace (via `unshare -n`)
   * when that tool is available, so a build cannot reach the network. Install phases
   * run with allowNetwork=true because they must fetch dependencies; build phases
   * run with allowNetwork=false. When `unshare` is unavailable — or when it exists
   * but cannot create a namespace in this environment (for example a non-root
   * CI runner, where `unshare -n` fails with "Operation not permitted") — the
   * run proceeds with network access and `networkIsolated` reports false —
   * callers log this. A real build failure is never masked by this fallback:
   * it only triggers on `unshare`'s own permission error, before the command
   * itself runs.
   */
  allowNetwork?: boolean;
  /** Resource limits via prlimit when available (CPU seconds, address-space MB, processes). */
  limits?: { cpuSeconds?: number; addressSpaceMb?: number; maxProcesses?: number };
}

export interface ExecutorResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  networkIsolated: boolean;
  limitsApplied: boolean;
}

export class ExecutorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const UN_SHARE = '/usr/bin/unshare';
const PRLIMIT = '/usr/bin/prlimit';

/**
 * Isolated command execution for untrusted template builds (docs/03 §4.2, AT-07).
 *
 * Guarantees in this implementation (process-level, NOT a VM):
 * - argv only, never a shell string, so manifest values cannot inject shell commands;
 * - scrubbed environment (PATH, HOME/TMPDIR inside the workdir, NODE_ENV, plus an
 *   explicit caller allowlist — no host secrets, no proxy credentials leak in);
 * - wall-clock timeout with whole-process-group kill;
 * - captured output capped, so a chatty build cannot fill the disk;
 * - optional network namespace for build phases and prlimit resource caps when the
 *   host tools exist (reported in the result so the pipeline can record what held).
 *
 * Production hardening still owed (recorded in PROJECT_STATUS): run builds as an
 * unprivileged uid and, for full tenant isolation, inside a real VM/sandbox with a
 * dependency proxy allowlist. This module is the seam where that executor plugs in.
 */
export async function runIsolated(argv: string[], opts: ExecutorOptions): Promise<ExecutorResult> {
  if (argv.length === 0) throw new ExecutorError('executor.empty_argv', 'no command given');
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const maxOutputBytes = opts.maxOutputBytes ?? 1024 * 1024;
  const allowNetwork = opts.allowNetwork ?? false;

  // Base command without the network-namespace wrapper.
  let baseCommand = argv;
  let limitsApplied = false;
  if (opts.limits && (await exists(PRLIMIT))) {
    const args: string[] = [];
    if (opts.limits.cpuSeconds !== undefined) args.push(`--cpu=${opts.limits.cpuSeconds}`);
    if (opts.limits.addressSpaceMb !== undefined) args.push(`--as=${opts.limits.addressSpaceMb * 1024 * 1024}`);
    if (opts.limits.maxProcesses !== undefined) args.push(`--nproc=${opts.limits.maxProcesses}`);
    if (args.length) {
      baseCommand = [PRLIMIT, ...args, '--', ...baseCommand];
      limitsApplied = true;
    }
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: opts.cwd,
    TMPDIR: `${opts.cwd}/.tmp`,
    NODE_ENV: 'production',
    npm_config_cache: `${opts.cwd}/.npm-cache`,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...(opts.env ?? {}),
  };

  const runOnce = (command: string[], networkIsolated: boolean): Promise<ExecutorResult> =>
    runCommand(command, { cwd: opts.cwd, env, timeoutMs, maxOutputBytes, networkIsolated, limitsApplied });

  if (!allowNetwork && (await exists(UN_SHARE))) {
    const wrapped = await runOnce([UN_SHARE, '-n', ...baseCommand], true);
    // `unshare -n` needs CAP_SYS_ADMIN, so on a non-root host (for example a
    // GitHub-hosted runner) it fails before the command runs, with its own
    // "unshare: ... Operation not permitted" error on stderr. That is not a
    // build failure: fall back to running without the namespace, exactly as
    // when the tool is absent, and report networkIsolated=false. Any other
    // failure (including a real build error) is returned as-is, unretried.
    if (
      wrapped.code !== 0 &&
      /unshare:/.test(wrapped.stderr) &&
      /Operation not permitted|Permission denied/.test(wrapped.stderr)
    ) {
      return runOnce(baseCommand, false);
    }
    return wrapped;
  }
  return runOnce(baseCommand, false);
}

interface RunCommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  networkIsolated: boolean;
  limitsApplied: boolean;
}

function runCommand(command: string[], opts: RunCommandOptions): Promise<ExecutorResult> {
  const { cwd, env, timeoutMs, maxOutputBytes, networkIsolated, limitsApplied } = opts;
  return new Promise<ExecutorResult>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command[0]!, command.slice(1), { cwd: opts.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ExecutorError('executor.spawn_failed', String(error)));
      return;
    }
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputTruncated = true;
        return;
      }
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    proc.stdout?.on('data', (c: Buffer) => collect(c, 'out'));
    proc.stderr?.on('data', (c: Buffer) => collect(c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(new ExecutorError('executor.spawn_failed', String(error)));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, outputTruncated, networkIsolated, limitsApplied });
    });
  });
}

/** Run a command and throw a StepError-shaped ExecutorError unless it exits 0. */
export async function runIsolatedOrThrow(argv: string[], opts: ExecutorOptions, failureCode: string): Promise<ExecutorResult> {
  const result = await runIsolated(argv, opts);
  if (result.timedOut) throw new ExecutorError('build_timeout', `command timed out after ${opts.timeoutMs ?? 10 * 60 * 1000}ms: ${argv.join(' ')}`);
  if (result.outputTruncated) throw new ExecutorError('build_output_exceeded', `command output exceeded the cap: ${argv.join(' ')}`);
  if (result.code !== 0) {
    throw new ExecutorError(failureCode, `${argv.join(' ')} exited ${result.code}: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`);
  }
  return result;
}
