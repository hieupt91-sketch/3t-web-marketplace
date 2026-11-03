/**
 * The runner's lifecycle core: fencing by row_version, the tracked-process
 * map persisted to an atomic JSON state file, boot adoption + orphan sweep,
 * and the RSS watchdog (impl contract §"Runner HTTP API" / §"Runner
 * internals"). Transport lives in server.ts; process primitives in
 * spawn.ts; pure state decisions in state.ts.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyOrphan, parseState, planAdoption, serializeState, type PidProbe, type TrackedEntry } from './state.js';
import { HealthFailedError, killPid, spawnServerLocal, type SpawnHandle, type SpawnSpec } from './spawn.js';
import type { SpawnRequest, StopRequest } from './validate.js';

export { HealthFailedError };

export class StaleVersionError extends Error {
  constructor() {
    super('stale_version');
    this.name = 'StaleVersionError';
  }
}

export type LogFn = (event: Record<string, unknown>) => void;

export interface RunnerServiceDeps {
  workRoot: string;
  log?: LogFn;
  /** Defaults to a real euid check; injectable for non-root test runs. */
  isRoot?: () => boolean;
  spawnImpl?: (spec: SpawnSpec, deps: { isRoot: () => boolean; log: LogFn }) => Promise<SpawnHandle>;
  probePid?: (pid: number) => PidProbe;
  listProcesses?: () => { pid: number; cwd: string }[];
  stateFile?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function defaultProbePid(pid: number): PidProbe {
  if (!pidAlive(pid)) return { alive: false };
  let cwd: string | undefined;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    /* process vanished mid-probe */
  }
  let uid: number | undefined;
  try {
    uid = statSync(`/proc/${pid}`).uid;
  } catch {
    /* vanished */
  }
  return { alive: true, cwd, uid };
}

function defaultListProcesses(): { pid: number; cwd: string }[] {
  const out: { pid: number; cwd: string }[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      out.push({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`) });
    } catch {
      /* vanished or not readable */
    }
  }
  return out;
}

/** VmRSS in KiB from /proc/<pid>/status, or undefined when unreadable. */
export function readVmRssKb(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export interface StatusResult {
  running: boolean;
  pid: number;
  port: number;
  rowVersion: number;
}

export class RunnerService {
  private readonly deps: Required<Omit<RunnerServiceDeps, 'stateFile'>> & { stateFile: string };
  private readonly entries = new Map<string, TrackedEntry>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private watchdogTimer: NodeJS.Timeout | undefined;

  constructor(deps: RunnerServiceDeps) {
    this.deps = {
      workRoot: deps.workRoot,
      log: deps.log ?? ((event) => console.log(JSON.stringify(event))),
      isRoot: deps.isRoot ?? (() => (process.getuid?.() ?? -1) === 0),
      spawnImpl: deps.spawnImpl ?? spawnServerLocal,
      probePid: deps.probePid ?? defaultProbePid,
      listProcesses: deps.listProcesses ?? defaultListProcesses,
      stateFile: deps.stateFile ?? join(deps.workRoot, '.runner-state.json'),
    };
  }

  get stateFile(): string {
    return this.deps.stateFile;
  }

  /**
   * Boot: adopt recorded processes that provably still are the site
   * processes (alive + same cwd + same uid), drop the rest, kill untracked
   * survivors of ephemeral (demo/import) trees, start the RSS watchdog.
   */
  boot(): { adopted: number; dropped: number; killedOrphans: number } {
    let recorded: TrackedEntry[] = [];
    if (existsSync(this.deps.stateFile)) {
      try {
        recorded = parseState(readFileSync(this.deps.stateFile, 'utf8'));
      } catch (error) {
        this.deps.log({ event: 'runner_state_unreadable', error: String(error) });
        recorded = [];
      }
    }
    const probes = new Map<string, PidProbe>(recorded.map((entry) => [entry.key, this.deps.probePid(entry.pid)]));
    const { adopted, dropped } = planAdoption(recorded, probes);
    for (const entry of adopted) this.entries.set(entry.key, entry);
    if (dropped.length > 0) {
      this.deps.log({ event: 'runner_state_pruned', dropped: dropped.map((entry) => entry.key) });
    }

    const trackedDirs = new Set(adopted.map((entry) => entry.dir));
    const trackedPids = new Set(adopted.map((entry) => entry.pid));
    let killedOrphans = 0;
    for (const proc of this.deps.listProcesses()) {
      if (trackedPids.has(proc.pid)) continue;
      if (classifyOrphan(proc.cwd, this.deps.workRoot, trackedDirs) === 'kill') {
        killPid(proc.pid);
        killedOrphans++;
        this.deps.log({ event: 'runner_orphan_kill', pid: proc.pid, cwd: proc.cwd });
      }
    }

    this.persist();
    this.watchdogTimer = setInterval(() => this.watchdogTick(), 15000);
    this.watchdogTimer.unref?.();
    this.deps.log({ event: 'runner_boot', adopted: adopted.length, dropped: dropped.length, killedOrphans });
    return { adopted: adopted.length, dropped: dropped.length, killedOrphans };
  }

  shutdown(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private persist(): void {
    const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
    mkdirSync(dirname(this.deps.stateFile), { recursive: true });
    writeFileSync(tmp, serializeState(this.entries.values()));
    renameSync(tmp, this.deps.stateFile);
  }

  /** Serialize operations per key so two spawns for one site can't race. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Liveness is one-directional: refresh may demote alive → dead (the pid
   * vanished), but never resurrect an entry already marked dead — the
   * watchdog/exit path may have SIGTERMed it and the signal is still in
   * flight while the pid technically exists.
   */
  private refresh(entry: TrackedEntry): boolean {
    if (entry.alive && !(entry.pid > 0 && pidAlive(entry.pid))) entry.alive = false;
    return entry.alive;
  }

  /**
   * Fencing: a live tracked process is replaceable only by a strictly
   * greater rowVersion; a dead one by rowVersion >= stored. On success the
   * stored version becomes the request's rowVersion.
   */
  async spawn(req: SpawnRequest): Promise<{ port: number; pid: number; limitsApplied: boolean; uidApplied: boolean }> {
    return this.withLock(req.key, async () => {
      const existing = this.entries.get(req.key);
      if (existing) {
        const live = this.refresh(existing);
        if (live && req.rowVersion <= existing.rowVersion) throw new StaleVersionError();
        if (!live && req.rowVersion < existing.rowVersion) throw new StaleVersionError();
      }
      let handle: SpawnHandle;
      try {
        handle = await this.deps.spawnImpl(
          {
            kind: req.kind,
            dir: req.dir,
            ...(req.start !== undefined ? { start: req.start } : {}),
            healthPath: req.healthPath,
            env: req.env,
            uid: req.uid,
            gid: req.gid,
            limits: {
              cpuSeconds: req.limits.cpuSeconds,
              addressSpaceMb: req.limits.addressSpaceMb,
              maxProcesses: req.limits.maxProcesses,
              fileSizeMb: req.limits.fileSizeMb,
            },
          },
          { isRoot: this.deps.isRoot, log: this.deps.log },
        );
      } catch (error) {
        if (error instanceof HealthFailedError) throw error;
        throw new HealthFailedError(error instanceof Error ? error.message : String(error));
      }
      const entry: TrackedEntry = {
        key: req.key,
        rowVersion: req.rowVersion,
        kind: req.kind,
        dir: req.dir,
        pid: handle.pid,
        port: handle.port,
        uid: req.uid,
        gid: req.gid,
        rssMb: req.limits.rssMb,
        alive: true,
      };
      this.entries.set(req.key, entry);
      this.procs.set(req.key, handle.proc);
      handle.proc.on('exit', () => {
        const current = this.entries.get(req.key);
        if (current && current.pid === handle.pid) {
          current.alive = false;
          this.persist();
          this.deps.log({ event: 'runner_child_exit', key: req.key, pid: handle.pid });
        }
        if (this.procs.get(req.key) === handle.proc) this.procs.delete(req.key);
      });
      this.persist();
      this.deps.log({ event: 'runner_spawned', key: req.key, pid: handle.pid, port: handle.port, rowVersion: req.rowVersion });
      return { port: handle.port, pid: handle.pid, limitsApplied: handle.limitsApplied, uidApplied: handle.uidApplied };
    });
  }

  /**
   * Idempotent stop: accepted iff rowVersion >= stored version (unknown key
   * → stopped:false). A stop carrying an older version must not kill a
   * newer spawn.
   */
  async stop(req: StopRequest): Promise<{ stopped: boolean }> {
    return this.withLock(req.key, async () => {
      const entry = this.entries.get(req.key);
      if (!entry) return { stopped: false };
      if (req.rowVersion < entry.rowVersion) return { stopped: false };
      killPid(entry.pid);
      this.procs.delete(req.key);
      this.entries.delete(req.key);
      this.persist();
      this.deps.log({ event: 'runner_stopped', key: req.key, pid: entry.pid, rowVersion: req.rowVersion });
      return { stopped: true };
    });
  }

  status(key: string): StatusResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const running = this.refresh(entry);
    return { running, pid: entry.pid, port: entry.port, rowVersion: entry.rowVersion };
  }

  /** One watchdog pass (the 15 s interval calls this; tests call it too). */
  watchdogTick(): void {
    let dirty = false;
    for (const entry of [...this.entries.values()]) {
      if (!entry.alive) continue;
      if (!pidAlive(entry.pid)) {
        entry.alive = false;
        dirty = true;
        continue;
      }
      const rssKb = readVmRssKb(entry.pid);
      if (rssKb === undefined) continue;
      if (rssKb > entry.rssMb * 1024) {
        killPid(entry.pid);
        entry.alive = false;
        this.procs.delete(entry.key);
        dirty = true;
        this.deps.log({ event: 'runner_rss_kill', key: entry.key, pid: entry.pid, rssKb, rssMb: entry.rssMb });
      }
    }
    if (dirty) this.persist();
  }
}
