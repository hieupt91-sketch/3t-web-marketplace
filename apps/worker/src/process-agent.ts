import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PlatformConfig } from '@3t/core';
import { buildChildEnv, killPid, siteLimitsOf, spawnServer, type SpawnSpec } from './runtime-agent.ts';

/**
 * Process-agent dispatch (sandbox Phase 1, audit C-01).
 *
 * Every template-code spawn/stop in the worker goes through here. In
 * local mode (RUNTIME_AGENT_URL empty — dev, show env, tests) this is a
 * thin pass-through to the Phase 0 in-process spawner in
 * runtime-agent.ts, with identical behaviour.
 *
 * In remote mode the lifecycle belongs to the dedicated site-runner
 * service: a separate container whose environment holds NO platform
 * credentials, which fences spawns by the site's row_version and
 * enforces per-UID egress + an RSS watchdog. Remote mode FAILS CLOSED:
 * a runner error is thrown to the caller, never retried as a local
 * spawn — silently running template code in the worker container would
 * reopen exactly the holes Phase 1 exists to close.
 */

export type ProcessAgentMode = 'local' | 'remote';

export function processAgentMode(config: PlatformConfig): ProcessAgentMode {
  return config.runtimeAgentUrl ? 'remote' : 'local';
}

export interface SpawnedSiteProcess {
  port: number;
  pid: number;
  limitsApplied: boolean;
  uidApplied: boolean;
}

export interface SpawnSiteProcessArgs {
  /** Runner fencing key: the site id, 'demo-<session id>' or 'import-<run id>'. */
  key: string;
  /** Fencing token: the site's row_version; 1 for demos and import checks. */
  rowVersion: number;
  spec: SpawnSpec;
}

export interface StopSiteProcessArgs {
  key: string;
  rowVersion: number;
  /** The pid recorded by a LOCAL spawn. Meaningless (and ignored) in remote mode. */
  localPid?: number | null;
}

const CONNECT_TIMEOUT_MS = 5_000;
const SPAWN_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;

interface RunnerReply {
  status: number;
  json: Record<string, unknown> | null;
}

/** Minimal JSON client for the runner: 5 s connect timeout + a per-call overall timeout. */
function runnerRequest(
  config: PlatformConfig,
  options: { method: 'GET' | 'POST'; path: string; body?: unknown; timeoutMs: number; auth: boolean },
): Promise<RunnerReply> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, config.runtimeAgentUrl);
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string> = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (options.auth) headers['x-runner-token'] = config.runnerToken;
    const impl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const connectTimer = setTimeout(
      () => req.destroy(new Error(`site-runner connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    );
    const overallTimer = setTimeout(
      () => req.destroy(new Error(`site-runner ${options.path} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const timers = () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
    };
    const req = impl(url, { method: options.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        timers();
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          /* non-JSON body: json stays null and the caller falls back to the status */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        return;
      }
      socket.once('connect', () => clearTimeout(connectTimer));
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });
    req.on('error', (error) => {
      timers();
      reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Runner errors arrive as {error: string}; surface that string verbatim as the Error message. */
function runnerError(reply: RunnerReply, op: string): Error {
  const message =
    reply.json && typeof reply.json.error === 'string' ? reply.json.error : `site-runner ${op} failed (HTTP ${reply.status})`;
  return new Error(message);
}

/**
 * The wire body for POST /v1/spawn (contract: sandbox-phase1-impl.md).
 * Exported for tests. The child env is built with the same allowlist as
 * a local spawn (buildChildEnv); PORT is dropped because the runner
 * allocates the port and sets PORT itself, overriding any request value.
 * limits always carry rssMb (the runner's watchdog cap) alongside the
 * prlimit caps; the local spawner ignores the extra field by design.
 */
export function runnerSpawnBody(config: PlatformConfig, args: SpawnSiteProcessArgs): Record<string, unknown> {
  const { spec } = args;
  const env = buildChildEnv(config, spec, 0);
  delete env.PORT;
  return {
    key: args.key,
    rowVersion: args.rowVersion,
    kind: spec.kind,
    dir: spec.dir,
    ...(spec.start ? { start: spec.start } : {}),
    healthPath: spec.healthPath,
    env,
    ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
    ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    limits: { ...(spec.limits ?? siteLimitsOf(config)), rssMb: config.siteLimitRssMb },
    ...(spec.writableDir ? { writableDir: spec.writableDir } : {}),
  };
}

export async function spawnSiteProcess(config: PlatformConfig, args: SpawnSiteProcessArgs): Promise<SpawnedSiteProcess> {
  if (processAgentMode(config) === 'local') return spawnServer(config, args.spec);
  const reply = await runnerRequest(config, {
    method: 'POST',
    path: '/v1/spawn',
    body: runnerSpawnBody(config, args),
    timeoutMs: SPAWN_TIMEOUT_MS,
    auth: true,
  });
  if (reply.status !== 200 || !reply.json) throw runnerError(reply, 'spawn');
  return {
    port: Number(reply.json.port),
    pid: Number(reply.json.pid),
    limitsApplied: reply.json.limitsApplied === true,
    uidApplied: reply.json.uidApplied === true,
  };
}

export async function stopSiteProcess(config: PlatformConfig, args: StopSiteProcessArgs): Promise<{ stopped: boolean }> {
  if (processAgentMode(config) === 'local') {
    killPid(args.localPid ?? null);
    return { stopped: Boolean(args.localPid) };
  }
  // Remote: the recorded pid belongs to the runner's container and is
  // meaningless here; the runner stops by fencing key + version.
  const reply = await runnerRequest(config, {
    method: 'POST',
    path: '/v1/stop',
    body: { key: args.key, rowVersion: args.rowVersion },
    timeoutMs: STOP_TIMEOUT_MS,
    auth: true,
  });
  if (reply.status !== 200 || !reply.json) throw runnerError(reply, 'stop');
  return { stopped: reply.json.stopped === true };
}

/** Boot probe for remote mode: true only on a 200 {ok:true} from /healthz (no auth). Never throws. */
export async function probeRunnerHealth(config: PlatformConfig): Promise<boolean> {
  if (processAgentMode(config) === 'local') return false;
  try {
    const reply = await runnerRequest(config, { method: 'GET', path: '/healthz', timeoutMs: HEALTH_TIMEOUT_MS, auth: false });
    return reply.status === 200 && reply.json?.ok === true;
  } catch {
    return false;
  }
}
