/**
 * Runner state: what the runner tracks per key, how it is persisted, and —
 * as pure functions — how boot decides which recorded processes to adopt
 * and which untracked processes are orphans (impl contract §"Runner
 * internals"). The pure parts are unit-tested; the service supplies the
 * live /proc probes.
 */
import { relative, resolve, sep } from 'node:path';
import { isWithinRoot } from './validate.js';

export interface TrackedEntry {
  key: string;
  rowVersion: number;
  kind: 'static' | 'runtime';
  /** Absolute site tree path (the child's cwd). */
  dir: string;
  pid: number;
  port: number;
  uid: number;
  gid: number;
  /** RSS watchdog cap captured at spawn time. */
  rssMb: number;
  alive: boolean;
}

/** What a live probe of a recorded pid reports at boot. */
export interface PidProbe {
  alive: boolean;
  cwd?: string;
  uid?: number;
}

export function serializeState(entries: Iterable<TrackedEntry>): string {
  const list = [...entries].map((entry) => ({
    key: entry.key,
    rowVersion: entry.rowVersion,
    kind: entry.kind,
    dir: entry.dir,
    pid: entry.pid,
    port: entry.port,
    uid: entry.uid,
    gid: entry.gid,
    rssMb: entry.rssMb,
    alive: entry.alive,
  }));
  return JSON.stringify({ version: 1, entries: list }, null, 2);
}

function isTrackedEntry(value: unknown): value is TrackedEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.key === 'string' &&
    typeof e.rowVersion === 'number' &&
    (e.kind === 'static' || e.kind === 'runtime') &&
    typeof e.dir === 'string' &&
    typeof e.pid === 'number' &&
    typeof e.port === 'number' &&
    typeof e.uid === 'number' &&
    typeof e.gid === 'number' &&
    typeof e.rssMb === 'number' &&
    typeof e.alive === 'boolean'
  );
}

/** Defensive parse: any corruption yields fewer entries, never a crash. */
export function parseState(json: string): TrackedEntry[] {
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== 'object' || data === null) return [];
    const list = (data as { entries?: unknown }).entries;
    if (!Array.isArray(list)) return [];
    return list.filter(isTrackedEntry);
  } catch {
    return [];
  }
}

/**
 * Boot adoption: a recorded entry is adopted ONLY when its pid is alive AND
 * the process cwd still equals the recorded dir AND its uid still matches.
 * Anything else is dropped as stale (a reused pid must never be mistaken
 * for a site process).
 */
export function planAdoption(
  entries: TrackedEntry[],
  probes: ReadonlyMap<string, PidProbe>,
): { adopted: TrackedEntry[]; dropped: TrackedEntry[] } {
  const adopted: TrackedEntry[] = [];
  const dropped: TrackedEntry[] = [];
  for (const entry of entries) {
    const probe = probes.get(entry.key);
    if (!probe || !probe.alive || probe.cwd !== entry.dir || probe.uid !== entry.uid) {
      dropped.push(entry);
    } else {
      adopted.push({ ...entry, alive: true });
    }
  }
  return { adopted, dropped };
}

/**
 * Boot orphan classification for processes the state file does not know:
 * - 'tracked': cwd is a tracked site's tree — never touched here.
 * - 'kill': cwd is under an ephemeral tree (demo sessions, import runtime
 *   checks — both single-use, so a survivor at boot is a leak).
 * - 'leave': everything else, including untracked processes inside a SITE
 *   tree — sites are adopted only via the state file, never guessed at.
 */
export function classifyOrphan(
  cwd: string,
  workRoot: string,
  trackedDirs: ReadonlySet<string>,
): 'tracked' | 'kill' | 'leave' {
  const resolvedDir = resolve(cwd);
  if (trackedDirs.has(resolvedDir)) return 'tracked';
  if (!isWithinRoot(workRoot, resolvedDir)) return 'leave';
  const segments = relative(resolve(workRoot), resolvedDir).split(sep);
  if (segments.includes('demo-sessions')) return 'kill';
  if (segments.some((segment) => /^run-\d+$/.test(segment))) return 'kill';
  return 'leave';
}
