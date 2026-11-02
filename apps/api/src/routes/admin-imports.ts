import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from '@3t/core';
import {
  IMPORT_JOB_TYPE,
  IMPORT_STEPS,
  ObjectTooLargeError,
  emitEvent,
  enqueueJob,
  getImportPolicy,
  previewOrigin,
  tx,
  writeAudit,
  type Queryable,
} from '@3t/core';
import { OVERRIDE_KEYS, type ConfigurationOverrides } from '@3t/template-sdk';
import { requirePermission } from '../app.ts';
import { AppError, errors } from '../errors.ts';
import { idempotent } from '../lib/idempotency.ts';
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ImportRow {
  id: string;
  actor_id: string;
  source_kind: string;
  repo_id: string | null;
  commit_sha: string | null;
  subdir: string | null;
  name_hint: string;
  digest: string;
  status: string;
  detected_adapter: string | null;
  detection_json: Record<string, unknown> | null;
  inspection_json: Record<string, unknown> | null;
  effective_manifest_json: { manifest: Record<string, unknown>; inferred: string[] } | null;
  config_overrides_json: ConfigurationOverrides;
  config_revision: number;
  error_code: string | null;
  errors_json: unknown[];
  template_id: string | null;
  version_id: string | null;
  upload_session_id: string | null;
  cancel_requested_at: Date | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

function progressUrl(jobId: string) {
  return `/api/v1/jobs/${jobId}`;
}

function assertId(id: string) {
  if (!UUID.test(id)) throw errors.notFound();
}

async function loadImport(db: Queryable, id: string, lock = false): Promise<ImportRow> {
  assertId(id);
  const { rows } = await db.query<ImportRow>(`SELECT * FROM imports WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw errors.notFound();
  return rows[0];
}

/** Next dedupe key for a pipeline run of this import (one job per run, retries reuse the job). */
async function nextRunKey(db: Queryable, importId: string): Promise<string> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE resource_type = 'import' AND resource_id = $1", [importId]);
  return `import:${importId}:run:${Number(rows[0]!.n) + 1}`;
}

async function enqueueRun(client: PoolClient, row: ImportRow, actorId: string) {
  const { job } = await enqueueJob(client, {
    type: IMPORT_JOB_TYPE,
    dedupeKey: await nextRunKey(client, row.id),
    payload: { import_id: row.id, config_revision: row.config_revision },
    resourceType: 'import',
    resourceId: row.id,
    ownerId: actorId,
    totalSteps: IMPORT_STEPS.length,
  });
  return job;
}

export async function adminImportRoutes(app: FastifyInstance): Promise<void> {
  const { db, store, config } = app.deps;

  async function importView(row: ImportRow) {
    const [steps, job, preview, screenshots] = await Promise.all([
      db.query<{ step: string; status: string; started_at: Date | null; finished_at: Date | null; error_code: string | null; detail_json: Record<string, unknown> }>(
        'SELECT step, status, started_at, finished_at, error_code, detail_json FROM import_steps WHERE import_id = $1 ORDER BY position',
        [row.id],
      ),
      db.query<{ id: string; status: string; attempts: number; max_attempts: number; step: string | null; next_run_at: Date }>(
        "SELECT id, status, attempts, max_attempts, step, next_run_at FROM jobs WHERE resource_type = 'import' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1",
        [row.id],
      ),
      db.query<{ host_label: string; status: string; visibility: string; created_at: Date }>(
        "SELECT host_label, status, visibility, created_at FROM previews WHERE import_id = $1 AND status = 'active'",
        [row.id],
      ),
      db.query<{ id: string; metadata_json: { viewport?: string; locale?: string } }>(
        `SELECT a.id, a.metadata_json FROM artifacts a
         WHERE a.kind = 'screenshot' AND (a.metadata_json->>'import_id' = $1 OR a.metadata_json->>'version_id' = $2)
         ORDER BY a.created_at`,
        [row.id, row.version_id ?? ''],
      ),
    ]);
    const detection = row.detection_json as { confidence?: string; missingFields?: string[]; candidates?: unknown[]; signals?: string[]; reason?: string; adapterImplemented?: boolean } | null;
    const latestJob = job.rows[0];
    const activePreview = preview.rows[0];
    return {
      id: row.id,
      source_kind: row.source_kind,
      repo_id: row.repo_id,
      commit_sha: row.commit_sha,
      subdir: row.subdir,
      name: row.name_hint,
      digest: row.digest,
      status: row.status,
      detected_adapter: row.detected_adapter,
      confidence: detection?.confidence ?? null,
      missing_fields: detection?.missingFields ?? [],
      detection: detection
        ? { candidates: detection.candidates ?? [], signals: detection.signals ?? [], reason: detection.reason ?? null, adapter_implemented: detection.adapterImplemented ?? null }
        : null,
      inspection: row.inspection_json,
      effective_manifest: row.effective_manifest_json?.manifest ?? null,
      inferred_fields: row.effective_manifest_json?.inferred ?? [],
      configuration: { revision: row.config_revision, overrides: row.config_overrides_json },
      error_code: row.error_code,
      errors: row.errors_json,
      steps: steps.rows.map((s) => ({
        step: s.step,
        status: s.status,
        started_at: s.started_at?.toISOString() ?? null,
        finished_at: s.finished_at?.toISOString() ?? null,
        error_code: s.error_code,
        detail: s.detail_json,
      })),
      job: latestJob
        ? { id: latestJob.id, status: latestJob.status, attempts: latestJob.attempts, max_attempts: latestJob.max_attempts, step: latestJob.step, progress_url: progressUrl(latestJob.id) }
        : null,
      draft: row.template_id ? { template_id: row.template_id, version_id: row.version_id } : null,
      preview: activePreview
        ? { status: activePreview.status, visibility: activePreview.visibility, url: `${previewOrigin(config, activePreview.host_label)}/`, created_at: activePreview.created_at.toISOString() }
        : null,
      screenshots: screenshots.rows.map((s) => ({ id: s.id, viewport: s.metadata_json.viewport ?? null, url: `/api/v1/admin/imports/${row.id}/screenshots/${s.id}` })),
      cancel_requested: row.cancel_requested_at !== null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  // A03: constrained upload session with declared size and checksum.
  app.post<{ Body: { filename: string; size_bytes: number; sha256: string; rights_confirmed: boolean } }>(
    '/imports/upload-sessions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['filename', 'size_bytes', 'sha256', 'rights_confirmed'],
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 255 },
            size_bytes: { type: 'integer', minimum: 1 },
            sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            rights_confirmed: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:import');
      const policy = await getImportPolicy(db);
      const body = request.body;
      const fieldErrors = [];
      if (!/\.zip$/i.test(body.filename) || /[/\\\u0000]/.test(body.filename)) fieldErrors.push({ field: 'filename', code: 'zip_required' });
      if (body.size_bytes > policy.max_upload_bytes) fieldErrors.push({ field: 'size_bytes', code: 'too_large' });
      if (body.rights_confirmed !== true) fieldErrors.push({ field: 'rights_confirmed', code: 'required' });
      if (fieldErrors.length) throw errors.validation(fieldErrors);
      const { rows } = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO upload_sessions (actor_id, filename, declared_size, declared_sha256, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [auth.userId, body.filename, body.size_bytes, body.sha256, policy.upload_session_ttl_minutes],
      );
      const session = rows[0]!;
      await writeAudit(db, { actorType: 'user', actorId: auth.userId, action: 'import.upload_session_created', resourceType: 'upload_session', resourceId: session.id, traceId: request.id, diff: { filename: body.filename, size_bytes: body.size_bytes, rights_confirmed: true } });
      return reply.status(201).send({
        data: {
          id: session.id,
          upload_url: `/api/v1/admin/imports/upload-sessions/${session.id}/content`,
          method: 'PUT',
          content_type: 'application/zip',
          max_bytes: String(body.size_bytes),
          expires_at: session.expires_at.toISOString(),
        },
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/imports/upload-sessions/:id/content',
    { bodyLimit: 1024 * 1024 * 1024 },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:import');
      assertId(request.params.id);
      const { rows } = await db.query<{ id: string; actor_id: string; status: string; declared_size: string; declared_sha256: string; expired: boolean }>(
        'SELECT id, actor_id, status, declared_size, declared_sha256, expires_at <= now() AS expired FROM upload_sessions WHERE id = $1',
        [request.params.id],
      );
      const session = rows[0];
      if (!session || session.actor_id !== auth.userId) throw errors.notFound();
      if (session.status !== 'pending') throw errors.conflict('upload.not_pending');
      if (session.expired) throw errors.conflict('upload.expired');
      const contentType = request.headers['content-type'] ?? '';
      if (!/^application\/(zip|octet-stream)\b/.test(contentType)) throw new AppError(415, 'request.unsupported_media_type');
      // Private storage outside any web root; still not public after upload (step 3, quarantine).
      const key = `sources/uploads/${session.id}.zip`;
      let stored: { size: number; sha256: string };
      try {
        stored = await store.putStream(key, request.body as Readable, Number(session.declared_size));
      } catch (error) {
        if (error instanceof ObjectTooLargeError) {
          await db.query("UPDATE upload_sessions SET status = 'failed', failure_code = 'size_mismatch' WHERE id = $1", [session.id]);
          throw errors.validation([{ field: 'content', code: 'size_mismatch' }], 'upload.size_mismatch');
        }
        throw error;
      }
      const failure =
        stored.size !== Number(session.declared_size) ? 'size_mismatch' : stored.sha256 !== session.declared_sha256 ? 'checksum_mismatch' : null;
      let signatureOk = false;
      if (!failure) {
        const head = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          store.read(key).on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(chunks).subarray(0, 4)));
        });
        signatureOk = head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || head.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      }
      const code = failure ?? (signatureOk ? null : 'not_zip');
      if (code) {
        await store.remove(key);
        await db.query("UPDATE upload_sessions SET status = 'failed', failure_code = $2 WHERE id = $1", [session.id, code]);
        throw errors.validation([{ field: 'content', code }], `upload.${code}`);
      }
      await db.query("UPDATE upload_sessions SET status = 'uploaded', quarantine_key = $2 WHERE id = $1 AND status = 'pending'", [session.id, key]);
      return reply.status(200).send({ data: { id: session.id, status: 'uploaded', size_bytes: String(stored.size), sha256: stored.sha256 } });
    },
  );

  app.post<{ Body: { upload_session_id: string } }>(
    '/imports',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['upload_session_id'],
          properties: { upload_session_id: { type: 'string', pattern: UUID.source } },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:import');
      const result = await idempotent(
        db,
        { key: request.headers['idempotency-key'], principal: `user:${auth.userId}`, route: 'POST /admin/imports', request: request.body },
        async (client) => {
          const { rows } = await client.query<{ id: string; actor_id: string; status: string; filename: string; declared_sha256: string; declared_size: string; quarantine_key: string }>(
            'SELECT * FROM upload_sessions WHERE id = $1 FOR UPDATE',
            [request.body.upload_session_id],
          );
          const session = rows[0];
          if (!session || session.actor_id !== auth.userId) throw errors.notFound();
          if (session.status === 'consumed') throw errors.conflict('upload.already_imported');
          if (session.status !== 'uploaded') throw errors.conflict('upload.not_uploaded');
          const artifact = await client.query<{ id: string }>(
            `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
             VALUES ($1, $2, $3, 'application/zip', 'source_archive', 'permanent', $4) RETURNING id`,
            [session.quarantine_key, session.declared_sha256, session.declared_size, { filename: session.filename }],
          );
          const nameHint = session.filename.replace(/\.zip$/i, '').slice(0, 120);
          const created = await client.query<ImportRow>(
            `INSERT INTO imports (actor_id, source_kind, upload_session_id, source_artifact_id, digest, name_hint, status)
             VALUES ($1, 'zip', $2, $3, $4, $5, 'queued') RETURNING *`,
            [auth.userId, session.id, artifact.rows[0]!.id, session.declared_sha256, nameHint],
          );
          const row = created.rows[0]!;
          await client.query(
            `INSERT INTO import_steps (import_id, step, position, status, started_at, finished_at)
             SELECT $1, step, ord, CASE WHEN ord <= 3 THEN 'succeeded' ELSE 'pending' END,
                    CASE WHEN ord <= 3 THEN now() END, CASE WHEN ord <= 3 THEN now() END
             FROM unnest($2::text[]) WITH ORDINALITY AS s(step, ord)`,
            [row.id, IMPORT_STEPS],
          );
          await client.query("UPDATE upload_sessions SET status = 'consumed' WHERE id = $1", [session.id]);
          const job = await enqueueRun(client, row, auth.userId);
          await emitEvent(client, 'import.received', 'import', row.id, { import_id: row.id });
          await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'import.created', resourceType: 'import', resourceId: row.id, traceId: request.id, diff: { digest: row.digest } });
          return { status: 202, body: { data: { job_id: job.id, resource_id: row.id, status: row.status, progress_url: progressUrl(job.id) } } };
        },
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string } }>('/imports', async (request) => {
    requirePermission(request, 'template:read');
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (request.query.status) {
      params.push(request.query.status);
      where.push(`status = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await db.query<ImportRow>(
      `SELECT * FROM imports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return page(rows, limit, (r) => ({
      id: r.id,
      name: r.name_hint,
      status: r.status,
      detected_adapter: r.detected_adapter,
      error_code: r.error_code,
      created_at: r.created_at.toISOString(),
    }));
  });

  app.get<{ Params: { id: string } }>('/imports/:id', async (request, reply) => {
    requirePermission(request, 'template:read');
    const row = await loadImport(db, request.params.id);
    reply.header('etag', `"${row.row_version}"`);
    return { data: await importView(row), meta: { request_id: request.id, revision: row.row_version } };
  });

  // A04: only allow-listed fields; each change is a new configuration revision and a new run.
  app.patch<{ Params: { id: string }; Body: ConfigurationOverrides }>(
    '/imports/:id/configuration',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            slug: { type: 'string', maxLength: 60 },
            version: { type: 'string', maxLength: 64 },
            name: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 200 }, propertyNames: { enum: ['vi', 'en'] } },
            summary: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 500 }, propertyNames: { enum: ['vi', 'en'] } },
            adapter: { enum: ['static-html', 'vite-static', 'next-standalone', 'node-http'] },
            projectRoot: { type: 'string', minLength: 1, maxLength: 255 },
            entry: { type: 'string', minLength: 1, maxLength: 255 },
            spaFallback: { type: 'boolean' },
            defaultLocale: { enum: ['vi', 'en'] },
            supportedLocales: { type: 'array', items: { enum: ['vi', 'en'] }, minItems: 1, uniqueItems: true },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:import');
      const match = request.headers['if-match']?.match(/^(?:W\/)?"(\d+)"$/);
      if (!match) throw new AppError(428, 'request.if_match_required');
      const result = await tx(db, async (client) => {
        const row = await loadImport(client, request.params.id, true);
        if (row.row_version !== Number(match[1])) throw errors.preconditionFailed();
        if (!['needs_configuration', 'failed'].includes(row.status)) throw errors.conflict('import.not_configurable');
        const overrides: ConfigurationOverrides = { ...row.config_overrides_json };
        for (const key of OVERRIDE_KEYS) {
          const value = request.body[key];
          if (value !== undefined) (overrides as Record<string, unknown>)[key] = value;
        }
        const updated = await client.query<ImportRow>(
          `UPDATE imports SET config_overrides_json = $2, config_revision = config_revision + 1, status = 'queued',
                  error_code = NULL, errors_json = '[]', row_version = row_version + 1 WHERE id = $1 RETURNING *`,
          [row.id, overrides],
        );
        const next = updated.rows[0]!;
        const job = await enqueueRun(client, next, auth.userId);
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'import.configured', resourceType: 'import', resourceId: row.id, traceId: request.id, diff: { revision: next.config_revision, changes: request.body as Record<string, unknown> } });
        return { next, job };
      });
      reply.header('etag', `"${result.next.row_version}"`);
      return reply.status(202).send({ data: { job_id: result.job.id, resource_id: result.next.id, status: result.next.status, progress_url: progressUrl(result.job.id) } });
    },
  );

  app.post<{ Params: { id: string } }>('/imports/:id/retry', async (request, reply) => {
    const auth = requirePermission(request, 'template:import');
    const result = await idempotent(
      db,
      { key: request.headers['idempotency-key'], principal: `user:${auth.userId}`, route: `POST /admin/imports/${request.params.id}/retry`, request: {} },
      async (client) => {
        const row = await loadImport(client, request.params.id, true);
        if (row.status !== 'failed') throw errors.conflict('import.not_retryable');
        const running = await client.query("SELECT 1 FROM jobs WHERE resource_type = 'import' AND resource_id = $1 AND status IN ('queued', 'running')", [row.id]);
        if (running.rowCount) throw errors.conflict('import.run_in_progress', true);
        await client.query("UPDATE imports SET status = 'queued', row_version = row_version + 1 WHERE id = $1", [row.id]);
        const job = await enqueueRun(client, row, auth.userId);
        await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'import.retried', resourceType: 'import', resourceId: row.id, traceId: request.id });
        return { status: 202, body: { data: { job_id: job.id, resource_id: row.id, status: 'queued', progress_url: progressUrl(job.id) } } };
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/imports/:id/cancel', async (request, reply) => {
    const auth = requirePermission(request, 'template:import');
    const status = await tx(db, async (client) => {
      const row = await loadImport(client, request.params.id, true);
      if (['ready', 'rejected', 'cancelled'].includes(row.status)) throw errors.conflict('import.not_cancellable');
      const running = await client.query<{ id: string }>(
        "SELECT id FROM jobs WHERE resource_type = 'import' AND resource_id = $1 AND status = 'running' AND lease_until > now()",
        [row.id],
      );
      // A running worker observes cancel_requested_at between steps and cleans up what it created.
      const immediate = running.rowCount === 0;
      await client.query(
        `UPDATE imports SET cancel_requested_at = now(), status = CASE WHEN $2 THEN 'cancelled' ELSE status END,
                row_version = row_version + 1 WHERE id = $1`,
        [row.id, immediate],
      );
      if (immediate) {
        await client.query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE resource_type = 'import' AND resource_id = $1 AND status IN ('queued', 'running')", [row.id]);
        await client.query("UPDATE previews SET status = 'revoked', revoked_at = now() WHERE import_id = $1 AND status = 'active'", [row.id]);
      }
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'import.cancel_requested', resourceType: 'import', resourceId: row.id, traceId: request.id });
      return immediate ? 'cancelled' : 'cancelling';
    });
    return reply.status(202).send({ data: { resource_id: request.params.id, status } });
  });

  // Delete a failed or cancelled import and the draft data it created.
  // Safety rules (agreed scope, enforced here and by the database):
  //  - only status 'failed' or 'cancelled', and no queued/running job;
  //  - the draft version must still be 'ready' (never published) and the
  //    template a draft with no published version and no other versions;
  //  - any commercial reference (order item, entitlement, download,
  //    site, deployment, demo session) or a live import pointing at the
  //    same template/version blocks the whole delete (409);
  //  - other failed/cancelled imports sharing the draft have their draft
  //    link cleared first, so the shared version can go away;
  //  - artifact rows and their stored blobs are immutable by design and
  //    are left untouched (content-addressed audit blobs, KBs each);
  //    everything relational (previews, capabilities, translations,
  //    version, template, steps, logs, jobs, build runs, the import row
  //    itself and its upload session) is removed in one transaction.
  app.delete<{ Params: { id: string } }>('/imports/:id', async (request, reply) => {
    const auth = requirePermission(request, 'template:import');
    const result = await tx(db, async (client) => {
      const row = await loadImport(client, request.params.id, true);
      if (!['failed', 'cancelled', 'rejected'].includes(row.status)) throw errors.conflict('import.not_deletable');
      const running = await client.query("SELECT 1 FROM jobs WHERE resource_type = 'import' AND resource_id = $1 AND status IN ('queued', 'running')", [row.id]);
      if (running.rowCount) throw errors.conflict('import.run_in_progress', true);

      let templateId = row.template_id;
      let versionId = row.version_id;
      let deletedTemplate = false;
      let deletedVersion = false;
      let nulledOtherImports = 0;

      if (versionId) {
        const v = await client.query<{ id: string; status: string; template_id: string }>('SELECT id, status, template_id FROM template_versions WHERE id = $1 FOR UPDATE', [versionId]);
        if (v.rows[0]) {
          const version = v.rows[0];
          if (version.status !== 'ready') throw errors.conflict('import.delete_blocked_version');
          templateId = version.template_id;
        } else {
          versionId = null;
        }
      }

      if (templateId) {
        const t = await client.query<{ id: string; status: string; published_version_id: string | null }>('SELECT id, status, published_version_id FROM templates WHERE id = $1 FOR UPDATE', [templateId]);
        if (t.rows[0]) {
          const tpl = t.rows[0];
          if (tpl.status !== 'draft' || tpl.published_version_id) throw errors.conflict('import.delete_blocked_published');
          const versions = await client.query('SELECT id FROM template_versions WHERE template_id = $1', [tpl.id]);
          if (versionId) {
            if (versions.rows.length !== 1 || versions.rows[0]!.id !== versionId) throw errors.conflict('import.delete_blocked_other_versions');
          } else if (versions.rows.length !== 0) {
            throw errors.conflict('import.delete_blocked_other_versions');
          }
          const others = await client.query<{ id: string; status: string }>('SELECT id, status FROM imports WHERE id <> $1 AND (template_id = $2 OR version_id = $3)', [row.id, tpl.id, versionId ?? '']);
          for (const other of others.rows) {
            if (!['failed', 'cancelled', 'rejected'].includes(other.status)) throw errors.conflict('import.delete_blocked_referenced');
          }
          if (others.rows.length) {
            await client.query('UPDATE imports SET template_id = NULL, version_id = NULL WHERE id = ANY($1)', [others.rows.map((o) => o.id)]);
            nulledOtherImports = others.rows.length;
          }
        } else {
          templateId = null;
        }
      }

      if (versionId) {
        const refs = await client.query(
          `SELECT 'order_items' AS src FROM order_items WHERE version_id = $1
           UNION ALL SELECT 'entitlements' FROM entitlements WHERE version_id = $1
           UNION ALL SELECT 'download_events' FROM download_events WHERE version_id = $1
           UNION ALL SELECT 'sites' FROM sites WHERE template_version_id = $1
           UNION ALL SELECT 'deployments' FROM deployments WHERE version_id = $1
           UNION ALL SELECT 'demo_sessions' FROM demo_sessions WHERE version_id = $1
           UNION ALL SELECT 'deployment_jobs' FROM deployments WHERE job_id IN (SELECT id FROM jobs WHERE resource_type = 'import' AND resource_id = $2)
           LIMIT 1`,
          [versionId, row.id],
        );
        if (refs.rowCount) throw errors.conflict('import.delete_blocked_referenced');
      }

      await client.query('DELETE FROM previews WHERE import_id = $1', [row.id]);
      // Mutual FKs (imports.version_id <-> template_versions.import_id and
      // imports.template_id -> templates) refuse deleting the version or
      // the template while this import still points at them, so break its
      // links first; the import row itself goes away below in this tx.
      // (Rejected/cancelled imports usually have no links, which is why
      // this only bites version-linked imports such as health failures.)
      await client.query('UPDATE imports SET version_id = NULL, template_id = NULL WHERE id = $1', [row.id]);
      if (versionId) {
        await client.query('DELETE FROM template_capabilities WHERE version_id = $1', [versionId]);
        // Migration 0015 lets the guard allow this: status 'ready' plus
        // every foreign key above already refused a referenced version.
        await client.query('DELETE FROM template_versions WHERE id = $1', [versionId]);
        deletedVersion = true;
      }
      if (templateId) {
        await client.query('DELETE FROM template_translations WHERE template_id = $1', [templateId]);
        await client.query('DELETE FROM templates WHERE id = $1', [templateId]);
        deletedTemplate = true;
      }
      await client.query('DELETE FROM build_runs WHERE import_id = $1', [row.id]);
      await client.query('DELETE FROM import_steps WHERE import_id = $1', [row.id]);
      await client.query('DELETE FROM import_logs WHERE import_id = $1', [row.id]);
      await client.query('DELETE FROM github_webhook_deliveries WHERE import_id = $1', [row.id]);
      await client.query("DELETE FROM jobs WHERE resource_type = 'import' AND resource_id = $1", [row.id]);
      const sessionId = row.upload_session_id;
      await client.query('DELETE FROM imports WHERE id = $1', [row.id]);
      if (sessionId) await client.query('DELETE FROM upload_sessions WHERE id = $1', [sessionId]);
      await writeAudit(client, { actorType: 'user', actorId: auth.userId, action: 'import.deleted', resourceType: 'import', resourceId: row.id, traceId: request.id, diff: { name: row.name_hint, deleted_template: deletedTemplate, deleted_version: deletedVersion, nulled_other_imports: nulledOtherImports } });
      return { deletedTemplate, deletedVersion, nulledOtherImports, name: row.name_hint };
    });
    return reply.send({ data: { resource_id: request.params.id, deleted: result } });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/imports/:id/logs', async (request) => {
    requirePermission(request, 'template:read');
    await loadImport(db, request.params.id);
    const after = request.query.after && /^\d+$/.test(request.query.after) ? request.query.after : '0';
    const limit = parseLimit(request.query.limit ?? '100');
    const { rows } = await db.query<{ id: string; step: string | null; level: string; code: string; message: string; created_at: Date }>(
      'SELECT id, step, level, code, message, created_at FROM import_logs WHERE import_id = $1 AND id > $2 ORDER BY id LIMIT $3',
      [request.params.id, after, limit + 1],
    );
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((r) => ({ id: r.id, step: r.step, level: r.level, code: r.code, message: r.message, created_at: r.created_at.toISOString() }));
    return { data, page: { next_cursor: data.length ? data[data.length - 1]!.id : after, has_more: hasMore } };
  });

  app.get<{ Params: { id: string; artifactId: string } }>('/imports/:id/screenshots/:artifactId', async (request, reply) => {
    requirePermission(request, 'template:read');
    assertId(request.params.id);
    assertId(request.params.artifactId);
    const { rows } = await db.query<{ object_key: string; size_bytes: string }>(
      `SELECT a.object_key, a.size_bytes FROM artifacts a JOIN imports i ON i.id = $2
       WHERE a.id = $1 AND a.kind = 'screenshot'
         AND (a.metadata_json->>'import_id' = i.id::text OR a.metadata_json->>'version_id' = i.version_id::text)`,
      [request.params.artifactId, request.params.id],
    );
    if (!rows[0]) throw errors.notFound();
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-length', rows[0].size_bytes);
    return reply.send(store.read(rows[0].object_key));
  });
}
