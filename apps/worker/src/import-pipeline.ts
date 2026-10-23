import { mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
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
}

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
  let completed = IMPORT_STEPS.indexOf('quarantine') + 1;

  const setStatus = (status: string) =>
    db.query('UPDATE imports SET status = $2, row_version = row_version + 1 WHERE id = $1', [importId, status]);

  async function checkCancelled() {
    const { rows } = await db.query<{ cancel_requested_at: Date | null }>('SELECT cancel_requested_at FROM imports WHERE id = $1', [importId]);
    if (rows[0]?.cancel_requested_at) throw new CancelledError();
  }

  async function step<T>(name: ImportStep, fn: () => Promise<T | 'skipped'>, skipReason?: string): Promise<T | 'skipped'> {
    await checkCancelled();
    await heartbeat(db, job, LEASE_SECONDS, { step: name, completedSteps: completed });
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
    await db.query(
      "UPDATE import_steps SET status = 'pending', started_at = NULL, finished_at = NULL, error_code = NULL WHERE import_id = $1 AND position > 3",
      [importId],
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
    await step('build', async () => 'skipped', 'static_html_has_no_build');

    await step('inspect_output', async () => {
      const manifest = state.manifest!;
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
    });

    await step('record', async () => {
      const manifest = state.manifest!;
      const site = await treeDigest(state.siteRoot!, state.siteFiles!);
      const key = `static-sites/${site.digest}`;
      await store.putTree(key, state.siteRoot!);
      const prefix = manifest.projectRoot === '.' ? '' : `${manifest.projectRoot}/`;
      const sizeBytes = state.siteFiles!.reduce((sum, f) => sum + (state.fileSizes.get(prefix + f) ?? 0), 0);
      const artifact = await db.query<{ id: string }>(
        `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
         VALUES ($1, $2, $3, 'inode/directory', 'static_site', 'permanent', $4)
         ON CONFLICT (object_key) DO NOTHING RETURNING id`,
        [key, site.digest, String(sizeBytes), { file_count: state.siteFiles!.length, entry: manifest.runtime.entry }],
      );
      state.siteArtifactId =
        artifact.rows[0]?.id ?? (await db.query<{ id: string }>('SELECT id FROM artifacts WHERE object_key = $1', [key])).rows[0]!.id;
      await db.query(
        `INSERT INTO build_runs (import_id, attempt, adapter, adapter_version, status, artifact_id, finished_at)
         VALUES ($1, (SELECT COALESCE(max(attempt), 0) + 1 FROM build_runs WHERE import_id = $1), $2, $3, 'succeeded', $4, now())`,
        [importId, manifest.adapter, STATIC_ADAPTER_VERSION, state.siteArtifactId],
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

    await step('init_db', async () => 'skipped', 'database_engine_none');

    await setStatus('validating');
    const previewGet = (path: string) => httpGetWithHost(config.previewInternalUrl, `${state.previewLabel}.${config.previewBaseDomain}`, path);

    await step('health', async () => {
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
        const url = `${previewOrigin(config, state.previewLabel!)}/`;
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
          "UPDATE imports SET status = 'ready', error_code = NULL, errors_json = '[]', row_version = row_version + 1 WHERE id = $1",
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

