/**
 * Fail-closed request validation for the runner API (impl contract
 * §"Validation"). Everything arriving from the worker is treated as
 * untrusted: the runner re-checks keys, paths, UIDs, argv and env itself,
 * because the runner — not the caller — is the security boundary.
 */
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface RunnerLimits {
  cpuSeconds: number;
  addressSpaceMb: number;
  maxProcesses: number;
  fileSizeMb: number;
  rssMb: number;
}

export interface SpawnRequest {
  key: string;
  rowVersion: number;
  kind: 'static' | 'runtime';
  /** Normalized absolute path, inside RUNNER_WORK_ROOT. */
  dir: string;
  /** Runtime kind only; validated argv, element 0 is 'node' or the runner's execPath. */
  start?: string[];
  healthPath: string;
  env: Record<string, string>;
  /**
   * Optional as a pair — mirrors the worker's spawnServer semantics: when
   * sandbox fencing is off (dev/show-env) the worker sends neither, and
   * the child keeps the runner's own uid (uidApplied=false). Production
   * always sends both. Exactly one of the pair is a validation error.
   */
  uid?: number;
  gid?: number;
  limits: RunnerLimits;
  /** Normalized absolute path when present. */
  writableDir?: string;
}

export interface StopRequest {
  key: string;
  rowVersion: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; details: string };

export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Substrings that must never appear in a child env key (fail-closed). */
const ENV_DENY_SUBSTRINGS = ['SECRET', 'PASSWORD', 'TOKEN', 'DATABASE', 'MFA', 'PRIVATE'];
/** Known platform variable names, rejected even if a substring slipped by. */
const ENV_DENY_EXACT = new Set([
  'DATABASE_URL',
  'MFA_KEY',
  'PARTNER_WEBHOOK_KEY',
  'PARTNER_LINK_SECRET',
  'MOCK_PAYMENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_TOKEN',
  'RUNNER_TOKEN',
  'SESSION_SECRET',
  'JWT_SECRET',
]);

/** UID pool (sandbox Phase 0): demos 19998, import checks 19999, sites 20000–20499. */
export const DEMO_UID = 19998;
export const IMPORT_UID = 19999;
export const SITE_UID_MIN = 20000;
export const SITE_UID_MAX = 20499;

export function isAllowedUid(uid: number): boolean {
  return uid === DEMO_UID || uid === IMPORT_UID || (uid >= SITE_UID_MIN && uid <= SITE_UID_MAX);
}

/** The full UID pool, for the egress ruleset. */
export function siteUidList(): number[] {
  const out = [DEMO_UID, IMPORT_UID];
  for (let uid = SITE_UID_MIN; uid <= SITE_UID_MAX; uid++) out.push(uid);
  return out;
}

/** True when `dir` (resolved against `root` when relative) is the root or beneath it. */
export function isWithinRoot(root: string, dir: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedDir = resolve(resolvedRoot, dir);
  return resolvedDir === resolvedRoot || resolvedDir.startsWith(resolvedRoot + sep);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export interface ValidateContext {
  workRoot: string;
  siteGid: number;
  /** The runner's own process.execPath — the only non-'node' argv[0] allowed. */
  execPath: string;
}

export function validateKey(key: unknown): string | null {
  return typeof key === 'string' && KEY_PATTERN.test(key) ? key : null;
}

function validateRowVersion(value: unknown, errors: string[]): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  errors.push('rowVersion must be an integer >= 1');
  return 0;
}

function validateEnv(raw: unknown, errors: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  if (raw === undefined) return env;
  if (!isPlainObject(raw)) {
    errors.push('env must be an object');
    return env;
  }
  const entries = Object.entries(raw);
  if (entries.length > 64) errors.push('env must have at most 64 entries');
  for (const [name, value] of entries) {
    if (!ENV_KEY_PATTERN.test(name)) {
      errors.push(`env key ${JSON.stringify(name)} is not a valid environment name`);
      continue;
    }
    if (ENV_DENY_EXACT.has(name) || ENV_DENY_SUBSTRINGS.some((part) => name.includes(part))) {
      errors.push(`env key ${name} is denied (platform credential class)`);
      continue;
    }
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
      errors.push(`env value for ${name} must be a string of at most 4096 chars without NUL`);
      continue;
    }
    env[name] = value;
  }
  return env;
}

function validateStart(raw: unknown, ctx: ValidateContext, errors: string[]): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
    errors.push('start must be an array of 1..32 strings');
    return undefined;
  }
  const argv: string[] = [];
  for (const element of raw) {
    if (typeof element !== 'string' || element.length > 512 || element.includes('\0')) {
      errors.push('every start element must be a string of at most 512 chars without NUL');
      return undefined;
    }
    argv.push(element);
  }
  const head = argv[0]!;
  if (head !== 'node' && head !== ctx.execPath) {
    errors.push("start[0] must be exactly 'node' or the runner's own execPath");
    return undefined;
  }
  return argv;
}

function validateLimits(raw: unknown, errors: string[]): RunnerLimits {
  const limits: RunnerLimits = { cpuSeconds: 0, addressSpaceMb: 0, maxProcesses: 0, fileSizeMb: 0, rssMb: 0 };
  if (!isPlainObject(raw)) {
    errors.push('limits must be an object');
    return limits;
  }
  const ranges: [keyof RunnerLimits, number, number][] = [
    ['cpuSeconds', 1, 604800],
    ['addressSpaceMb', 256, 65536],
    ['maxProcesses', 1, 1024],
    ['fileSizeMb', 1, 4096],
    ['rssMb', 64, 8192],
  ];
  for (const [field, min, max] of ranges) {
    const value = raw[field];
    if (isIntIn(value, min, max)) limits[field] = value;
    else errors.push(`limits.${field} must be an integer in ${min}..${max}`);
  }
  return limits;
}

export function validateSpawnBody(raw: unknown, ctx: ValidateContext): Validation<SpawnRequest> {
  if (!isPlainObject(raw)) return { ok: false, details: 'body must be a JSON object' };
  const errors: string[] = [];

  const key = validateKey(raw.key);
  if (key === null) errors.push('key must match /^[a-z0-9][a-z0-9-]{0,79}$/');
  const rowVersion = validateRowVersion(raw.rowVersion, errors);

  const kind = raw.kind;
  if (kind !== 'static' && kind !== 'runtime') errors.push("kind must be 'static' or 'runtime'");

  // dir: containment first (no filesystem touch on escaping paths), then
  // existence — the runner only ever serves trees under its work root.
  let dir = '';
  if (typeof raw.dir !== 'string' || raw.dir.length === 0 || raw.dir.includes('\0')) {
    errors.push('dir must be a non-empty string');
  } else if (!isWithinRoot(ctx.workRoot, raw.dir)) {
    errors.push('dir escapes RUNNER_WORK_ROOT');
  } else {
    dir = resolve(ctx.workRoot, raw.dir);
    try {
      if (!statSync(dir).isDirectory()) errors.push('dir is not a directory');
    } catch {
      errors.push('dir does not exist');
    }
  }

  let writableDir: string | undefined;
  if (raw.writableDir !== undefined) {
    if (typeof raw.writableDir !== 'string' || raw.writableDir.includes('\0') || !isWithinRoot(ctx.workRoot, raw.writableDir)) {
      errors.push('writableDir must be a path inside RUNNER_WORK_ROOT');
    } else {
      writableDir = resolve(ctx.workRoot, raw.writableDir);
    }
  }

  let start: string[] | undefined;
  if (kind === 'runtime') {
    if (raw.start === undefined) errors.push('start is required for runtime kind');
    else start = validateStart(raw.start, ctx, errors);
  } else if (raw.start !== undefined) {
    // Static argv is built runner-side; a supplied start is still validated
    // fail-closed, then ignored.
    validateStart(raw.start, ctx, errors);
  }

  let healthPath = '';
  if (
    typeof raw.healthPath === 'string' &&
    raw.healthPath.startsWith('/') &&
    raw.healthPath.length <= 256 &&
    !/[\u0000-\u0020]/.test(raw.healthPath)
  ) {
    healthPath = raw.healthPath;
  } else {
    errors.push('healthPath must be a string starting with /, at most 256 chars, no control chars or spaces');
  }

  const env = validateEnv(raw.env, errors);

  let uid: number | undefined;
  let gid: number | undefined;
  if (raw.uid === undefined && raw.gid === undefined) {
    // Unfenced spawn (dev/show-env): allowed, child keeps the runner's uid.
  } else if (raw.uid === undefined || raw.gid === undefined) {
    errors.push('uid and gid must be provided together or not at all');
  } else {
    if (typeof raw.uid === 'number' && Number.isInteger(raw.uid) && isAllowedUid(raw.uid)) uid = raw.uid;
    else errors.push(`uid must be one of ${DEMO_UID}, ${IMPORT_UID} or in ${SITE_UID_MIN}..${SITE_UID_MAX}`);
    if (raw.gid === ctx.siteGid) gid = ctx.siteGid;
    else errors.push(`gid must equal RUNNER_SITE_GID (${ctx.siteGid})`);
  }

  const limits = validateLimits(raw.limits, errors);

  if (errors.length > 0 || key === null || (kind !== 'static' && kind !== 'runtime')) {
    return { ok: false, details: errors.join('; ') };
  }
  return {
    ok: true,
    value: {
      key,
      rowVersion,
      kind,
      dir,
      ...(start !== undefined ? { start } : {}),
      healthPath,
      env,
      uid,
      gid,
      limits,
      ...(writableDir !== undefined ? { writableDir } : {}),
    },
  };
}

export function validateStopBody(raw: unknown): Validation<StopRequest> {
  if (!isPlainObject(raw)) return { ok: false, details: 'body must be a JSON object' };
  const errors: string[] = [];
  const key = validateKey(raw.key);
  if (key === null) errors.push('key must match /^[a-z0-9][a-z0-9-]{0,79}$/');
  const rowVersion = validateRowVersion(raw.rowVersion, errors);
  if (errors.length > 0 || key === null) return { ok: false, details: errors.join('; ') };
  return { ok: true, value: { key, rowVersion } };
}
