import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runIsolated, runIsolatedOrThrow, ExecutorError } from './executor.ts';
import {
  IMPORT_ERROR_OUTCOME,
  IMPORT_STEPS,
  RETRYABLE_IMPORT_ERRORS,
  completeJob,
  emitEvent,
  failJob,
  cancelJob,
  getImportPolicy,
  heartbeat,
  httpGetWithHost,
  isUniqueViolation,
  previewOrigin,
  randomLabel,
  tx,
  writeAudit,
  type Db,
  type ImportStep,
  type JobRow,
  type LocalObjectStore,
  type PlatformConfig,
  type Queryable,
} from '@3t/core';
import {
  ArchiveError,
  IMPLEMENTED_ADAPTERS,
  MANIFEST_FILE,
  buildEffectiveManifest,
  detectAdapter,
  extractArchive,
  fileExistenceIssues,
  inspectStaticSite,
  parseManifestText,
  scanForSecrets,
  treeDigest,
  validateManifest,
  type ConfigurationOverrides,
  type DetectionResult,
  type TemplateManifest,
} from '@3t/template-sdk';
import type { Screenshotter } from './screenshots.ts';

export const LEASE_SECONDS = 60;
export const STATIC_ADAPTER_VERSION = 'static-html@1';

export interface PipelineDeps {
  config: PlatformConfig;
  db: Db;
  store: LocalObjectStore;
  screenshotter: Screenshotter | null;
}

/** A step outcome that stops the pipeline with a machine code. */
export class StepError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: unknown[] = [],
  ) {
    super(code);
  }
}

class CancelledError extends Error {}

interface ImportRecord {
  id: string;
  actor_id: string;
  name_hint: string;
  source_artifact_id: string;
  config_overrides_json: ConfigurationOverrides;
  config_revision: number;
  cancel_requested_at: Date | null;
  digest: string;
  checkpoint_json: Checkpoint | null;
}

/** Persisted pipeline state for checkpoint resume (migration 0007). */
interface Checkpoint {
  step: ImportStep;
  sourceArchiveDigest: string;
  configRevision: number;
  detection?: DetectionResult;
  manifest?: TemplateManifest;
  siteFiles?: string[];
  sourceDigest?: string;
  siteArtifactId?: string;
  versionId?: string;
  templateId?: string;
  previewLabel?: string;
  entryAssets?: string[];
  htmlFiles?: string[];
  reusedVersion?: boolean;
  runtimeBundleKey?: string;
  runtimeStart?: string[];
  runtimeHealthPath?: string;
}

/** Steps whose completion is checkpointed (from `detect` onward). */
const CHECKPOINT_STEPS = new Set<ImportStep>(['detect', 'validate_manifest', 'policy', 'build', 'inspect_output', 'record', 'provision_preview', 'init_db', 'health', 'smoke']);

interface RunState {
  workspace: string;
  sourceDir: string;
  files: string[];
  fileSizes: Map<string, number>;
  directories: Set<string>;
  declared: Record<string, unknown> | null;
  detection?: DetectionResult;
  manifest?: TemplateManifest;
  siteRoot?: string;
  siteFiles?: string[];
  entryAssets?: string[];
  htmlFiles?: string[];
  sourceDigest?: string;
  siteArtifactId?: string;
  versionId?: string;
  templateId?: string;
  previewLabel?: string;
  reusedVersion?: boolean;
  runtimeBundleKey?: string;
  runtimeStart?: string[];
  runtimeHealthPath?: string;
  runtimeServer?: { proc: ChildProcess; port: number; dir: string };
}

/** Walk a directory, returning POSIX-relative file paths (symlinks skipped). */
async function walkFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(root, full)));
    else if (entry.isFile()) out.push(full.slice(root.length + 1).split('/').join('/'));
  }
  return out.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Allocate a free localhost port (bind 0, read, close; small race accepted for dev/preview). */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

function httpGetLocal(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function log(db: Queryable, importId: string, step: ImportStep | null, level: 'info' | 'warn' | 'error', code: string, message: string) {
  await db.query('INSERT INTO import_logs (import_id, step, level, code, message) VALUES ($1, $2, $3, $4, $5)', [
    importId,
    step,
    level,
    code,
    message.slice(0, 2000),
  ]);
}

function directoriesOf(files: string[]): Set<string> {
  const dirs = new Set<string>(['.']);
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

function withinRoot(root: string, files: string[]): string[] {
  if (root === '.') return files;
  const prefix = `${root}/`;
  return files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
}

/** Map an executor failure to a pipeline step error code. */
function toStepError(error: unknown, fallback: string): StepError {
  if (error instanceof ExecutorError) {
    if (error.code === 'build_timeout') return new StepError('build_timeout', [{ reason: error.message.slice(0, 500) }]);
    if (error.code === 'build_output_exceeded') return new StepError('build_failed', [{ reason: error.message.slice(0, 500) }]);
    return new StepError(fallback, [{ reason: error.message.slice(0, 500) }]);
  }
  if (error instanceof StepError) return error;
  return new StepError(fallback, [{ reason: String(error).slice(0, 500) }]);
}

function detectPackageManager(projectDir: string, files: string[], declared?: string): 'npm' | 'pnpm' | 'yarn' {
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn') return declared;
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

/**
 * Build a vite-static / node-http / next-standalone package inside the executor.
 * Install runs with network (dependencies must be fetched); the build script runs
 * network-isolated. Returns the directory that holds the runnable/static output.
 */
async function buildAdapter(deps: PipelineDeps, state: RunState, manifest: TemplateManifest, importId: string): Promise<{ outputDir: string; runtimeDir: string }> {
  const projectDir = state.siteRoot!;
  const projectFiles = state.siteFiles!;
  const pkgPath = join(projectDir, 'package.json');
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    pkg = null;
  }
  if (!pkg) throw new StepError('build_failed', [{ reason: 'package_json_missing_or_invalid' }]);
  const pm = detectPackageManager(projectDir, projectFiles, manifest.build?.packageManager);
  const limits = { cpuSeconds: 600, addressSpaceMb: 4096, maxProcesses: 256 };

  // Install (network allowed; scripts disabled so dependency code cannot run yet).
  if (!(await pathExists(join(projectDir, 'node_modules')))) {
    const lockfile = manifest.build?.lockfile;
    let installArgv: string[];
    if (pm === 'npm') installArgv = lockfile === 'package-lock.json' ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
    else if (pm === 'pnpm') installArgv = ['pnpm', 'install', '--ignore-scripts', '--frozen-lockfile'];
    else installArgv = ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'];
    try {
      const res = await runIsolatedOrThrow(installArgv, { cwd: projectDir, allowNetwork: true, timeoutMs: 10 * 60 * 1000, limits }, 'install_failed');
      await log(deps.db, importId, 'build', 'info', 'install_ok', `Install finished (networkIsolated=${res.networkIsolated}, limits=${res.limitsApplied}).`.slice(0, 200));
    } catch (error) {
      throw toStepError(error, 'install_failed');
    }
  }

  // Build (network-isolated) unless the adapter needs no build.
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const script = manifest.build?.script ?? 'build';
  if (scripts[script]) {
    try {
      await runIsolatedOrThrow([pm, 'run', script], { cwd: projectDir, allowNetwork: false, timeoutMs: 10 * 60 * 1000, limits }, 'build_failed');
    } catch (error) {
      throw toStepError(error, 'build_failed');
    }
  } else if (manifest.adapter === 'vite-static') {
    throw new StepError('build_failed', [{ reason: 'build_script_missing', script }]);
  }

  if (manifest.adapter === 'vite-static') {
    const outputDir = join(projectDir, manifest.build?.outputDir ?? 'dist');
    if (!(await pathExists(outputDir))) throw new StepError('build_failed', [{ reason: 'output_dir_missing', outputDir: manifest.build?.outputDir ?? 'dist' }]);
    return { outputDir, runtimeDir: outputDir };
  }

  if (manifest.adapter === 'next-standalone') {
    const standalone = join(projectDir, '.next', 'standalone');
    if (!(await pathExists(join(standalone, 'server.js')))) throw new StepError('build_failed', [{ reason: 'standalone_server_missing' }]);
    // Standalone output does not copy public/ or .next/static by itself (docs/03 S3).
    const copies: [string, string][] = [
      [join(projectDir, 'public'), join(standalone, 'public')],
      [join(projectDir, '.next', 'static'), join(standalone, '.next', 'static')],
    ];
    for (const [from, to] of copies) {
      if (await pathExists(from)) await cp(from, to, { recursive: true, force: true });
    }
    return { outputDir: standalone, runtimeDir: standalone };
  }

  // node-http: the project dir itself is runnable.
  const start = manifest.runtime.start ?? (typeof pkg.main === 'string' ? ['node', pkg.main] : null);
  if (!start) throw new StepError('build_failed', [{ reason: 'start_missing' }]);
  return { outputDir: projectDir, runtimeDir: projectDir };
}

/** Copy a runtime bundle out of the store into a writable dir and spawn its server. */
async function spawnRuntimeServer(deps: PipelineDeps, state: RunState, manifest: TemplateManifest): Promise<{ proc: ChildProcess; port: number; dir: string }> {
  const dir = join(state.workspace, 'runtime');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const bundlePath = deps.store.pathFor(state.runtimeBundleKey!);
  await cp(bundlePath, dir, { recursive: true, dereference: false });
  // Store files are read-only; the server needs writable working files.
  const { chmod } = await import('node:fs/promises');
  const makeWritable = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await chmod(full, 0o755);
        await makeWritable(full);
      } else if (entry.isFile()) await chmod(full, 0o644);
    }
  };
  await chmod(dir, 0o755);
  await makeWritable(dir);
  const port = await freePort();
  const start = state.runtimeStart ?? manifest.runtime.start ?? ['node', 'server.js'];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
  };
  for (const item of manifest.env) {
    if (item.scope === 'public' && item.defaultValue !== undefined) env[item.name] = item.defaultValue;
  }
  const proc = spawn(start[0]!, start.slice(1), { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain output so a chatty server cannot block on a full pipe.
  proc.stdout?.on('data', () => undefined);
  proc.stderr?.on('data', () => undefined);
  return { proc, port, dir };
}

async function stopRuntimeServer(server: { proc: ChildProcess } | undefined): Promise<void> {
  if (!server) return;
  try {
    if (server.proc.pid) process.kill(-server.proc.pid, 'SIGTERM');
  } catch {
    server.proc.kill('SIGTERM');
  }
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    server.proc.once('exit', done);
    setTimeout(() => {
      try {
        if (server.proc.pid) process.kill(-server.proc.pid, 'SIGKILL');
      } catch {
        server.proc.kill('SIGKILL');
      }
      resolve();
    }, 3000);
  });
}

export async function runImportJob(deps: PipelineDeps, job: JobRow): Promise<void> {
  const { db, config, store } = deps;
  const importId = String(job.payload_json.import_id);
  const loaded = await db.query<ImportRecord & { object_key: string }>(
    `SELECT i.*, a.object_key FROM imports i JOIN artifacts a ON a.id = i.source_artifact_id WHERE i.id = $1`,
    [importId],
  );
  const record = loaded.rows[0];
  if (!record) {
    await failJob(db, job, 'import_missing', false);
    return;
  }
  const workspace = join(config.workDir, importId, `run-${job.fencing_token}`);
  const state: RunState = { workspace, sourceDir: join(workspace, 'src'), files: [], fileSizes: new Map(), directories: new Set(), declared: null };
  // Checkpoint resume: a previous run's state is trusted only when it was produced from
  // the same source archive and the same configuration revision. The cheap head steps
  // (inspect/resolve/scan) always re-run and re-validate; `build` is only skipped when
  // the site artifact was already recorded (build output itself is workspace-local).
  const checkpoint = record.checkpoint_json;
  const checkpointValid =
    checkpoint !== null &&
    checkpoint.sourceArchiveDigest === record.digest &&
    checkpoint.configRevision === record.config_revision;
  const resumeStep = checkpointValid ? checkpoint.step : null;
  const resumePosition = resumeStep ? IMPORT_STEPS.indexOf(resumeStep) + 1 : IMPORT_STEPS.indexOf('quarantine') + 1;
  let completed = resumePosition;
  const shouldSkip = (name: ImportStep): boolean => {
    if (!resumeStep) return false;
    if (name === 'inspect_archive' || name === 'resolve_root' || name === 'secret_scan') return false;
    if (name === 'build' && IMPORT_STEPS.indexOf(resumeStep) < IMPORT_STEPS.indexOf('record')) return false;
    // Runtime adapters serve from a spawned server that died with the old workspace,
    // so provision/health/smoke/screenshots always re-run against a fresh server.
    if (state.manifest && (state.manifest.adapter === 'node-http' || state.manifest.adapter === 'next-standalone') &&
        (name === 'provision_preview' || name === 'health' || name === 'smoke' || name === 'screenshots')) return false;
    return IMPORT_STEPS.indexOf(name) <= IMPORT_STEPS.indexOf(resumeStep);
  };
  const applyCheckpoint = (name: ImportStep): void => {
    const cp = checkpoint!;
    if (name === 'detect') state.detection = cp.detection;
    if (name === 'validate_manifest') state.manifest = cp.manifest;
    if (name === 'policy') {
      state.siteRoot = join(state.sourceDir, ...(cp.manifest!.projectRoot === '.' ? [] : cp.manifest!.projectRoot.split('/')));
      state.siteFiles = cp.siteFiles;
      state.sourceDigest = cp.sourceDigest;
    }
    if (name === 'inspect_output') {
      state.entryAssets = cp.entryAssets;
      state.htmlFiles = cp.htmlFiles;
    }
    if (name === 'record') {
      state.siteArtifactId = cp.siteArtifactId;
      state.versionId = cp.versionId;
      state.templateId = cp.templateId;
      state.reusedVersion = cp.reusedVersion;
      state.runtimeBundleKey = cp.runtimeBundleKey;
    }
    if (name === 'provision_preview') state.previewLabel = cp.previewLabel;
  };
  const saveCheckpoint = async (name: ImportStep): Promise<void> => {
    if (!CHECKPOINT_STEPS.has(name)) return;
    const snap: Checkpoint = {
      step: name,
      sourceArchiveDigest: record.digest,
      configRevision: record.config_revision,
      detection: state.detection,
      manifest: state.manifest,
      siteFiles: state.siteFiles,
      sourceDigest: state.sourceDigest,
      siteArtifactId: state.siteArtifactId,
      versionId: state.versionId,
      templateId: state.templateId,
      previewLabel: state.previewLabel,
      entryAssets: state.entryAssets,
      htmlFiles: state.htmlFiles,
      reusedVersion: state.reusedVersion,
      runtimeBundleKey: state.runtimeBundleKey,
      runtimeStart: state.runtimeStart,
      runtimeHealthPath: state.runtimeHealthPath,
    };
    await db.query('UPDATE imports SET checkpoint_json = $2 WHERE id = $1', [importId, snap]);
  };

  const setStatus = (status: string) =>
    db.query('UPDATE imports SET status = $2, row_version = row_version + 1 WHERE id = $1', [importId, status]);

  async function checkCancelled() {
    const { rows } = await db.query<{ cancel_requested_at: Date | null }>('SELECT cancel_requested_at FROM imports WHERE id = $1', [importId]);
    if (rows[0]?.cancel_requested_at) throw new CancelledError();
  }

  async function step<T>(name: ImportStep, fn: () => Promise<T | 'skipped'>, skipReason?: string): Promise<T | 'skipped'> {
    await checkCancelled();
    await heartbeat(db, job, LEASE_SECONDS, { step: name, completedSteps: completed });
    // Checkpoint resume: the step row already says `succeeded` from the previous run
    // (the reset below preserves it); restore state and move on without re-running.
    if (shouldSkip(name)) {
      applyCheckpoint(name);
      await log(db, importId, name, 'info', 'checkpoint_resumed', `Resumed from checkpoint at ${resumeStep}; step ${name} reused.`);
      completed += 1;
      return 'skipped';
    }
    await db.query(
      `UPDATE import_steps SET status = 'running', started_at = now(), finished_at = NULL, error_code = NULL,
              detail_json = '{}', attempt = attempt + 1 WHERE import_id = $1 AND step = $2`,
      [importId, name],
    );
    try {
      const result = await fn();
      const skipped = result === 'skipped';
      await db.query(
        `UPDATE import_steps SET status = $3, finished_at = now(), detail_json = $4 WHERE import_id = $1 AND step = $2`,
        [importId, name, skipped ? 'skipped' : 'succeeded', skipped ? { reason: skipReason ?? 'not_applicable' } : stepDetail(name, state)],
      );
      if (!skipped) await saveCheckpoint(name);
      completed += 1;
      return result;
    } catch (error) {
      const code = error instanceof StepError ? error.code : error instanceof CancelledError ? 'cancelled' : 'internal_error';
      await db.query(
        `UPDATE import_steps SET status = 'failed', finished_at = now(), error_code = $3, detail_json = $4 WHERE import_id = $1 AND step = $2`,
        [importId, name, code, { details: error instanceof StepError ? error.details.slice(0, 50) : [] }],
      );
      throw error;
    }
  }

  try {
    await mkdir(state.sourceDir, { recursive: true });
    await setStatus('inspecting');
    // Reset only the steps after the checkpoint (plus the head steps, which always re-run).
    // Steps at or before the checkpoint keep their `succeeded` rows for the resume above.
    await db.query(
      "UPDATE import_steps SET status = 'pending', started_at = NULL, finished_at = NULL, error_code = NULL WHERE import_id = $1 AND position > $2",
      [importId, resumePosition],
    );
    const policy = await getImportPolicy(db);
    const overrides = record.config_overrides_json ?? {};

    await step('inspect_archive', async () => {
      try {
        const inspection = await extractArchive(store.pathFor(record.object_key), state.sourceDir, {
          maxTotalUncompressedBytes: policy.max_uncompressed_bytes,
          maxEntryBytes: policy.max_entry_bytes,
          maxFiles: policy.max_files,
          maxCompressionRatio: policy.max_compression_ratio,
          ratioCheckMinBytes: 1024 * 1024,
        });
        state.files = inspection.files.map((f) => f.path);
        state.fileSizes = new Map(inspection.files.map((f) => [f.path, f.size]));
        state.directories = directoriesOf(state.files);
        await db.query('UPDATE imports SET inspection_json = $2 WHERE id = $1', [
          importId,
          {
            file_count: inspection.files.length,
            total_uncompressed_bytes: String(inspection.totalUncompressedBytes),
            stripped_prefix: inspection.strippedPrefix,
            excluded: inspection.excluded.slice(0, 100),
          },
        ]);
        for (const item of inspection.excluded.filter((e) => e.reason === 'git_history').slice(0, 1)) {
          await log(db, importId, 'inspect_archive', 'warn', 'git_history_excluded', `Excluded .git history from the build workspace (${item.path}).`);
        }
        await log(db, importId, 'inspect_archive', 'info', 'archive_ok', `Archive accepted: ${inspection.files.length} files.`);
      } catch (error) {
        if (error instanceof ArchiveError) {
          throw new StepError(error.code, error.issues.map((i) => ({ reason: i.reason, entry: i.entry ?? null })));
        }
        throw new StepError('source_unavailable');
      }
    });

    await step('resolve_root', async () => {
      const nestedManifests = state.files.filter((f) => f.endsWith(`/${MANIFEST_FILE}`));
      if (state.files.includes(MANIFEST_FILE)) {
        const parsed = parseManifestText(await readFile(join(state.sourceDir, MANIFEST_FILE), 'utf8'));
        if (!parsed.ok) throw new StepError('manifest_invalid', [parsed.issue]);
        state.declared = parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>) : null;
        if (!state.declared) throw new StepError('manifest_invalid', [{ pointer: '', code: 'invalid_type', detail: 'manifest must be an object' }]);
      } else if (nestedManifests.length > 1 && overrides.projectRoot === undefined) {
        throw new StepError('project_root_ambiguous', nestedManifests.map((path) => ({ manifest: path })));
      }
    });

    await step('secret_scan', async () => {
      const findings = await scanForSecrets(
        state.sourceDir,
        state.files.map((path) => ({ path, size: state.fileSizes.get(path) ?? 0 })),
      );
      if (findings.length) throw new StepError('secret_detected', findings);
    });

    await step('detect', async () => {
      const declaredAdapter = typeof state.declared?.adapter === 'string' ? (state.declared.adapter as TemplateManifest['adapter']) : null;
      let detection = await detectAdapter(state.sourceDir, state.files, declaredAdapter);
      if (detection.status !== 'unsupported' && (overrides.adapter || overrides.projectRoot)) {
        const adapter = overrides.adapter ?? detection.adapter;
        detection = {
          ...detection,
          status: adapter ? 'detected' : detection.status,
          adapter,
          projectRoot: overrides.projectRoot ?? detection.projectRoot,
          confidence: 'declared',
          adapterImplemented: adapter ? IMPLEMENTED_ADAPTERS.includes(adapter) : null,
        };
      }
      state.detection = detection;
      await db.query('UPDATE imports SET detected_adapter = $2, detection_json = $3 WHERE id = $1', [importId, detection.adapter, detection]);
      if (detection.status === 'unsupported') throw new StepError('adapter_unsupported', [{ reason: detection.reason, signals: detection.signals }]);
      if (detection.status === 'needs_configuration' && !state.declared) {
        throw new StepError('needs_configuration', detection.missingFields.map((pointer) => ({ pointer, code: 'required' })));
      }
    });

    await step('validate_manifest', async () => {
      const effective = buildEffectiveManifest(state.detection!, state.declared, { nameHint: record.name_hint }, overrides);
      await db.query('UPDATE imports SET effective_manifest_json = $2 WHERE id = $1', [importId, effective]);
      const result = validateManifest(effective.manifest);
      if (!result.ok) throw new StepError('manifest_invalid', result.issues);
      const missing = fileExistenceIssues(result.manifest, new Set(state.files), state.directories);
      if (missing.length) throw new StepError('manifest_invalid', missing);
      state.manifest = result.manifest;
    });

    await step('policy', async () => {
      const manifest = state.manifest!;
      if (!IMPLEMENTED_ADAPTERS.includes(manifest.adapter)) {
        throw new StepError('policy_denied', [{ reason: 'adapter_not_implemented', adapter: manifest.adapter }]);
      }
      const inferredOnly = !state.declared && Object.keys(overrides).length === 0;
      if (inferredOnly && (!policy.static_auto_continue || state.detection?.confidence === 'low')) {
        throw new StepError('needs_configuration', [{ pointer: '/slug', code: 'confirm_inferred' }]);
      }
      state.siteRoot = join(state.sourceDir, ...(manifest.projectRoot === '.' ? [] : manifest.projectRoot.split('/')));
      state.siteFiles = withinRoot(manifest.projectRoot, state.files);
      // Version conflict check early for fast feedback; authoritative check runs again in `record`.
      const { digest } = await treeDigest(state.sourceDir, state.files);
      state.sourceDigest = digest;
      const existing = await db.query<{ source_sha: string }>(
        'SELECT v.source_sha FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE t.slug = $1 AND v.semver = $2',
        [manifest.slug, manifest.version],
      );
      if (existing.rows[0] && existing.rows[0].source_sha !== digest) {
        throw new StepError('version_conflict', [{ pointer: '/version', code: 'semver_exists_with_different_source' }]);
      }
    });

    await setStatus('building');
    await step('build', async () => {
      const manifest = state.manifest!;
      if (manifest.adapter === 'static-html') return 'skipped';
      const built = await buildAdapter(deps, state, manifest, importId);
      if (manifest.adapter === 'vite-static') {
        // The static output becomes the new site root for inspection + recording.
        state.siteRoot = built.outputDir;
        state.siteFiles = await walkFiles(built.outputDir);
        const prefix = manifest.projectRoot === '.' ? '' : `${manifest.projectRoot}/`;
        for (const file of state.siteFiles) {
          state.fileSizes.set(prefix + file, (await stat(join(built.outputDir, ...file.split('/')))).size);
        }
      } else {
        // Runtime adapters: bundle the runnable tree (without node_modules) for
        // preview/demo/site provisioning; the runtime reinstalls deps from lockfile.
        const staging = join(workspace, 'runtime-bundle');
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        const allFiles = await walkFiles(built.runtimeDir);
        const bundleFiles = allFiles.filter((f) => f !== 'node_modules' && !f.startsWith('node_modules/'));
        for (const file of bundleFiles) {
          const from = join(built.runtimeDir, ...file.split('/'));
          const to = join(staging, ...file.split('/'));
          await mkdir(join(to, '..'), { recursive: true });
          await cp(from, to);
        }
        const { digest } = await treeDigest(staging, bundleFiles);
        const key = `runtime-bundles/${digest}`;
        await store.putTree(key, staging);
        state.runtimeBundleKey = key;
        state.runtimeStart = manifest.runtime.start ?? undefined;
        state.runtimeHealthPath = manifest.runtime.healthPath ?? '/';
        state.siteFiles = bundleFiles;
      }
      return undefined;
    }, 'static_html_has_no_build');

    await step('inspect_output', async () => {
      const manifest = state.manifest!;
      if (manifest.adapter === 'node-http' || manifest.adapter === 'next-standalone') return 'skipped';
      const entry = manifest.runtime.entry ?? 'index.html';
      const result = await inspectStaticSite(state.siteRoot!, state.siteFiles!, entry);
      if (!result.entryExists) throw new StepError('artifact_invalid', [{ reason: 'entry_missing', path: entry }]);
      if (result.deniedFiles.length) throw new StepError('policy_denied', result.deniedFiles.map((path) => ({ reason: 'executable_not_allowed', path })));
      const entryBroken = result.brokenReferences.filter((b) => b.file === entry);
      if (entryBroken.length) throw new StepError('artifact_invalid', entryBroken.map((b) => ({ reason: 'broken_reference', ...b })));
      for (const broken of result.brokenReferences.slice(0, 20)) {
        await log(db, importId, 'inspect_output', 'warn', 'broken_reference', `${broken.file} references missing ${broken.reference}`);
      }
      state.entryAssets = result.entryAssets;
      state.htmlFiles = result.htmlFiles;
    }, 'runtime_adapter_no_static_output');

    await step('record', async () => {
      const manifest = state.manifest!;
      const isRuntime = manifest.adapter === 'node-http' || manifest.adapter === 'next-standalone';
      let key: string;
      let digest: string;
      let sizeBytes: number;
      let kind: string;
      let adapterVersion: string;
      if (isRuntime) {
        // The runtime bundle was already stored by the build step; record it.
        key = state.runtimeBundleKey!;
        digest = key.split('/').pop()!;
        const bundleDir = store.pathFor(key);
        const bundleFiles = await walkFiles(bundleDir);
        sizeBytes = 0;
        for (const file of bundleFiles) sizeBytes += (await stat(join(bundleDir, ...file.split('/')))).size;
        kind = 'runtime_bundle';
        adapterVersion = `${manifest.adapter}@1`;
      } else {
        const site = await treeDigest(state.siteRoot!, state.siteFiles!);
        key = `static-sites/${site.digest}`;
        digest = site.digest;
        await store.putTree(key, state.siteRoot!);
        const prefix = manifest.projectRoot === '.' ? '' : `${manifest.projectRoot}/`;
        sizeBytes = state.siteFiles!.reduce((sum, f) => sum + (state.fileSizes.get(prefix + f) ?? 0), 0);
        kind = 'static_site';
        adapterVersion = STATIC_ADAPTER_VERSION;
      }
      const artifact = await db.query<{ id: string }>(
        `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
         VALUES ($1, $2, $3, 'inode/directory', $5, 'permanent', $4)
         ON CONFLICT (object_key) DO NOTHING RETURNING id`,
        [key, digest, String(sizeBytes), { file_count: state.siteFiles!.length, entry: manifest.runtime.entry }, kind],
      );
      state.siteArtifactId =
        artifact.rows[0]?.id ?? (await db.query<{ id: string }>('SELECT id FROM artifacts WHERE object_key = $1', [key])).rows[0]!.id;
      await db.query(
        `INSERT INTO build_runs (import_id, attempt, adapter, adapter_version, status, artifact_id, finished_at)
         VALUES ($1, (SELECT COALESCE(max(attempt), 0) + 1 FROM build_runs WHERE import_id = $1), $2, $3, 'succeeded', $4, now())`,
        [importId, manifest.adapter, adapterVersion, state.siteArtifactId],
      );
      try {
        await tx(db, async (client) => {
          const template = await client.query<{ id: string }>(
            `INSERT INTO templates (slug, owner_id) VALUES ($1, $2)
             ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
            [manifest.slug, record.actor_id],
          );
          const templateId = template.rows[0]!.id;
          state.templateId = templateId;
          for (const [locale, title] of Object.entries(manifest.name)) {
            if (locale !== 'vi' && locale !== 'en') continue;
            // Draft translations seeded from the manifest; existing edited translations are never overwritten.
            const slug = locale === manifest.locales.default ? manifest.slug : `${manifest.slug}-${locale}`;
            await client.query(
              `INSERT INTO template_translations (template_id, locale, title, summary, slug, status)
               VALUES ($1, $2, $3, $4, $5, 'draft') ON CONFLICT (template_id, locale) DO NOTHING`,
              [templateId, locale, title.slice(0, 200), manifest.summary[locale] ?? null, slug],
            );
          }
          const existing = await client.query<{ id: string; source_sha: string }>(
            'SELECT id, source_sha FROM template_versions WHERE template_id = $1 AND semver = $2 FOR UPDATE',
            [templateId, manifest.version],
          );
          if (existing.rows[0]) {
            if (existing.rows[0].source_sha !== state.sourceDigest) throw new StepError('version_conflict', [{ pointer: '/version', code: 'semver_exists_with_different_source' }]);
            state.versionId = existing.rows[0].id;
            state.reusedVersion = true;
          } else {
            const version = await client.query<{ id: string }>(
              `INSERT INTO template_versions (template_id, semver, schema_version, manifest_json, adapter, source_sha, source_artifact_id, artifact_id, import_id)
               VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [templateId, manifest.version, manifest, manifest.adapter, state.sourceDigest, record.source_artifact_id, state.siteArtifactId, importId],
            );
            state.versionId = version.rows[0]!.id;
            for (const capability of manifest.capabilities) {
              await client.query('INSERT INTO template_capabilities (version_id, capability) VALUES ($1, $2)', [state.versionId, capability]);
            }
            await emitEvent(client, 'artifact.ready', 'template_version', state.versionId, { import_id: importId, artifact_id: state.siteArtifactId });
          }
          await client.query('UPDATE imports SET template_id = $2, version_id = $3 WHERE id = $1', [importId, templateId, state.versionId]);
        });
      } catch (error) {
        if (error instanceof StepError) throw error;
        if (isUniqueViolation(error, 'template_translations_locale_slug_uq')) {
          throw new StepError('manifest_invalid', [{ pointer: '/slug', code: 'slug_taken_in_locale' }]);
        }
        throw new StepError('persistence_failed');
      }
      if (state.reusedVersion) await log(db, importId, 'record', 'info', 'version_reused', `Version ${manifest.version} already exists with identical source; reusing it.`);
    });

    await setStatus('provisioning');
    await step('provision_preview', async () => {
      const manifest = state.manifest!;
      if (manifest.adapter === 'node-http' || manifest.adapter === 'next-standalone') {
        // Runtime adapters have no static preview origin: spawn the bundle locally.
        // The M5 runtime agent generalises this spawn into per-site processes.
        await stopRuntimeServer(state.runtimeServer);
        state.runtimeServer = await spawnRuntimeServer(deps, state, manifest);
        state.runtimeHealthPath = state.runtimeHealthPath ?? manifest.runtime.healthPath ?? '/';
        await log(db, importId, 'provision_preview', 'info', 'runtime_spawned', `Runtime server spawned on 127.0.0.1:${state.runtimeServer.port} for health/smoke.`);
        return;
      }
      const label = randomLabel();
      await tx(db, async (client) => {
        await client.query("UPDATE previews SET status = 'revoked', revoked_at = now() WHERE import_id = $1 AND status = 'active'", [importId]);
        await client.query(
          `INSERT INTO previews (host_label, import_id, version_id, artifact_id, entry, spa_fallback, visibility)
           VALUES ($1, $2, $3, $4, $5, $6, 'draft')`,
          [label, importId, state.versionId, state.siteArtifactId, state.manifest!.runtime.entry ?? 'index.html', state.manifest!.runtime.spaFallback ?? false],
        );
      });
      state.previewLabel = label;
    });

    await step('init_db', async () => 'skipped', state.manifest!.database.engine === 'none' ? 'database_engine_none' : 'database_provisioned_at_runtime');

    await setStatus('validating');
    const previewGet = (path: string) => httpGetWithHost(config.previewInternalUrl, `${state.previewLabel}.${config.previewBaseDomain}`, path);

    await step('health', async () => {
      const manifest = state.manifest!;
      if (state.runtimeServer) {
        const healthPath = state.runtimeHealthPath ?? manifest.runtime.healthPath ?? '/';
        let lastError = 'unreachable';
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const res = await httpGetLocal(state.runtimeServer.port, healthPath);
            if (res.status === 200) return;
            lastError = `status_${res.status}`;
          } catch {
            lastError = 'unreachable';
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
        throw new StepError('health_failed', [{ reason: lastError }]);
      }
      let lastError = 'unreachable';
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await previewGet('/__health');
          if (res.status === 200) return;
          lastError = `status_${res.status}`;
        } catch {
          lastError = 'unreachable';
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      throw new StepError('health_failed', [{ reason: lastError }]);
    });

    await step('smoke', async () => {
      if (state.runtimeServer) {
        const failures: { path: string; status: number | string }[] = [];
        for (const path of ['/', state.runtimeHealthPath ?? '/']) {
          try {
            const res = await httpGetLocal(state.runtimeServer.port, path);
            if (res.status !== 200) failures.push({ path, status: res.status });
          } catch {
            failures.push({ path, status: 'unreachable' });
          }
        }
        if (failures.length) throw new StepError('smoke_failed', failures);
        await log(db, importId, 'smoke', 'info', 'smoke_ok', `Checked ${2} URLs on the runtime server.`);
        return;
      }
      const entry = state.manifest!.runtime.entry ?? 'index.html';
      const deepLinks = state.htmlFiles!.filter((f) => f !== entry).slice(0, 3);
      const paths = ['/', ...state.entryAssets!.map((a) => `/${a}`), ...deepLinks.map((d) => `/${d}`)];
      const failures: { path: string; status: number | string }[] = [];
      for (const path of [...new Set(paths)].slice(0, 50)) {
        try {
          const res = await previewGet(encodeURI(path));
          if (res.status !== 200) failures.push({ path, status: res.status });
          else if (path === '/' && !String(res.headers['content-type']).startsWith('text/html')) failures.push({ path, status: 'not_html' });
        } catch {
          failures.push({ path, status: 'unreachable' });
        }
      }
      if (failures.length) throw new StepError('smoke_failed', failures);
      await log(db, importId, 'smoke', 'info', 'smoke_ok', `Checked ${paths.length} URLs on the preview origin.`);
    });

    await step(
      'screenshots',
      async () => {
        if (!deps.screenshotter) return 'skipped';
        const url = state.runtimeServer ? `http://127.0.0.1:${state.runtimeServer.port}/` : `${previewOrigin(config, state.previewLabel!)}/`;
        try {
          const shots = await deps.screenshotter.capture(url, state.manifest!.locales.default);
          for (const shot of shots) {
            const key = `screenshots/${shot.sha256}.png`;
            if (!(await store.exists(key))) {
              const { Readable } = await import('node:stream');
              await store.putStream(key, Readable.from(shot.data), 20 * 1024 * 1024);
            }
            await db.query(
              `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
               VALUES ($1, $2, $3, 'image/png', 'screenshot', 'standard', $4) ON CONFLICT (object_key) DO NOTHING`,
              [key, shot.sha256, String(shot.data.length), { import_id: importId, version_id: state.versionId, viewport: shot.viewport, locale: state.manifest!.locales.default }],
            );
          }
        } catch {
          // Screenshots are optional for readiness; the step is marked failed but the import continues.
          await log(db, importId, 'screenshots', 'warn', 'screenshot_failed', 'Screenshot capture failed; run the import again to retry.');
          throw new StepError('screenshot_failed');
        }
      },
      'screenshots_disabled',
    ).catch((error: unknown) => {
      if (error instanceof StepError && error.code === 'screenshot_failed') return 'skipped';
      throw error;
    });

    await step('ready', async () => {
      await tx(db, async (client) => {
        await client.query(
          "UPDATE imports SET status = 'ready', error_code = NULL, errors_json = '[]', checkpoint_json = NULL, row_version = row_version + 1 WHERE id = $1",
          [importId],
        );
        await emitEvent(client, 'version.ready', 'template_version', state.versionId!, { import_id: importId, template_id: state.templateId });
        await writeAudit(client, { actorType: 'worker', actorId: null, action: 'import.ready', resourceType: 'import', resourceId: importId, traceId: job.id, diff: { version_id: state.versionId } });
      });
    });
    await completeJob(db, job);
  } catch (error) {
    if (error instanceof CancelledError) {
      await tx(db, async (client) => {
        await client.query("UPDATE previews SET status = 'revoked', revoked_at = now() WHERE import_id = $1 AND status = 'active'", [importId]);
        await client.query("UPDATE imports SET status = 'cancelled', row_version = row_version + 1 WHERE id = $1", [importId]);
        await writeAudit(client, { actorType: 'worker', actorId: null, action: 'import.cancelled', resourceType: 'import', resourceId: importId, traceId: job.id });
      });
      await cancelJob(db, job);
      return;
    }
    const code = error instanceof StepError ? error.code : 'internal_error';
    const details = error instanceof StepError ? error.details.slice(0, 50) : [];
    const outcome = IMPORT_ERROR_OUTCOME[code] ?? 'failed';
    const retryable = RETRYABLE_IMPORT_ERRORS.has(code);
    const willRetry = retryable && job.attempts < job.max_attempts;
    await db.query(
      `UPDATE imports SET status = $2, error_code = $3, errors_json = $4, row_version = row_version + 1 WHERE id = $1`,
      [importId, willRetry ? 'queued' : outcome, code, JSON.stringify(details)],
    );
    await log(db, importId, null, 'error', code, willRetry ? `Step failed with ${code}; retry scheduled.` : `Import stopped with ${code}.`);
    if (outcome === 'failed') await failJob(db, job, code, retryable);
    else await completeJob(db, job); // business decision reached (rejected / needs_configuration)
  } finally {
    await stopRuntimeServer(state.runtimeServer);
    await rm(workspace, { recursive: true, force: true });
    await rmdir(join(config.workDir, importId)).catch(() => undefined); // only when no other run left files
  }
}

function stepDetail(name: ImportStep, state: RunState): Record<string, unknown> {
  switch (name) {
    case 'inspect_archive':
      return { file_count: state.files.length };
    case 'detect':
      return { adapter: state.detection?.adapter ?? null, confidence: state.detection?.confidence ?? null };
    case 'validate_manifest':
      return { slug: state.manifest?.slug, version: state.manifest?.version };
    case 'record':
      return { version_id: state.versionId, reused: state.reusedVersion ?? false };
    case 'provision_preview':
      return { preview: true };
    case 'smoke':
      return { checked: 1 + (state.entryAssets?.length ?? 0) };
    default:
      return {};
  }
}

