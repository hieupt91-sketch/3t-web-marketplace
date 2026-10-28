import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import {
  IMPORT_STEPS,
  enqueueJob,
  getImportPolicy,
  tx,
  writeAudit,
  type LocalObjectStore,
  type PlatformConfig,
  type Queryable,
} from '@3t/core';
import { requirePermission } from '../app.ts';
import { errors } from '../errors.ts';
import { idempotent } from '../lib/idempotency.ts';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function execFileAsync(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${String(stderr).slice(0, 500)}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(root, full)));
    else if (entry.isFile()) out.push(full.slice(root.length + 1).split('/').join('/'));
  }
  return out.sort();
}

async function githubFetch(config: PlatformConfig, path: string, accept: string): Promise<Response> {
  const res = await fetch(`${config.githubApiBaseUrl}${path}`, {
    headers: { 'user-agent': '3t-marketplace', accept },
    signal: AbortSignal.timeout(30_000),
  });
  return res;
}

/**
 * Import a public GitHub repo at a pinned commit (REQ-03, AT-04/AT-57).
 * The tarball is fetched, extracted with the system tar, optionally narrowed to a
 * subdirectory, and re-packed as a ZIP so the normal import pipeline (with all its
 * archive safety checks) runs unchanged. Only public repos work without credentials;
 * private repos fail as unavailable. No GitHub token is ever stored.
 */
export async function createGithubImport(
  client: Queryable,
  store: LocalObjectStore,
  config: PlatformConfig,
  input: { repo: string; ref?: string; subdir?: string; actorId: string },
): Promise<{ importId: string; jobId: string; commitSha: string }> {
  const { repo, actorId } = input;
  if (!REPO_RE.test(repo)) throw errors.badRequest('github.repo_invalid');
  const subdir = input.subdir ?? '';
  if (subdir !== '' && (subdir.startsWith('/') || subdir.split('/').includes('..') || subdir.includes('\\'))) throw errors.badRequest('github.subdir_invalid');
  const policy = await getImportPolicy(client);

  // Resolve the ref to a pinned commit SHA first; the tarball is then fetched at that SHA.
  const ref = input.ref ?? 'HEAD';
  let commitSha = '';
  if (ref === 'HEAD') {
    const repoRes = await githubFetch(config, `/repos/${repo}`, 'application/vnd.github+json');
    if (!repoRes.ok) throw errors.badRequest('github.repo_unavailable');
    const repoJson = (await repoRes.json()) as { default_branch?: string };
    const branch = repoJson.default_branch ?? 'main';
    const commitRes = await githubFetch(config, `/repos/${repo}/commits/${encodeURIComponent(branch)}`, 'application/vnd.github+json');
    if (!commitRes.ok) throw errors.badRequest('github.repo_unavailable');
    commitSha = ((await commitRes.json()) as { sha?: string }).sha ?? '';
  } else {
    const commitRes = await githubFetch(config, `/repos/${repo}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github+json');
    if (!commitRes.ok) throw errors.badRequest('github.repo_unavailable');
    commitSha = ((await commitRes.json()) as { sha?: string }).sha ?? '';
  }
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw errors.badRequest('github.repo_unavailable');

  const tarRes = await githubFetch(config, `/repos/${repo}/tarball/${commitSha}`, 'application/octet-stream');
  if (!tarRes.ok || !tarRes.body) throw errors.badRequest('github.repo_unavailable');

  const tmp = await mkdtemp(join(tmpdir(), 'mp-github-'));
  try {
    const tarball = join(tmp, 'repo.tgz');
    await pipeline(tarRes.body as unknown as NodeJS.ReadableStream, createWriteStream(tarball));
    const extracted = join(tmp, 'extracted');
    await mkdir(extracted, { recursive: true });
    await execFileAsync('tar', ['-xzf', tarball, '-C', extracted], tmp);
    const tops = (await readdir(extracted, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (tops.length !== 1) throw errors.badRequest('github.tarball_unexpected');
    let root = join(extracted, tops[0]!.name);
    if (subdir !== '') {
      root = join(root, ...subdir.split('/'));
      await readdir(root).catch(() => {
        throw errors.badRequest('github.subdir_invalid');
      });
    }
    const files = await walkFiles(root);
    if (files.length === 0 || files.length > policy.max_files) throw errors.badRequest('github.file_limit');
    const zipPath = join(tmp, 'repo.zip');
    await execFileAsync('zip', ['-q', '-r', zipPath, ...files], root);
    const zipStream = createReadStream(zipPath);
    const key = `github/${repo.replace('/', '-')}-${commitSha}.zip`;
    const stored = await store.putStream(key, zipStream, policy.max_upload_bytes + 1);

    {
      const artifact = await client.query<{ id: string }>(
        `INSERT INTO artifacts (object_key, sha256, size_bytes, media_type, kind, retention_class, metadata_json)
         VALUES ($1, $2, $3, 'application/zip', 'source_archive', 'permanent', $4) RETURNING id`,
        [key, stored.sha256, String(stored.size), { filename: `${repo}@${commitSha}.zip` }],
      );
      const nameHint = repo.split('/')[1]!.slice(0, 120);
      const created = await client.query<{ id: string }>(
        `INSERT INTO imports (actor_id, source_kind, source_artifact_id, digest, name_hint, repo_id, commit_sha, subdir, status)
         VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, 'queued') RETURNING id`,
        [actorId, artifact.rows[0]!.id, stored.sha256, nameHint, repo, commitSha, subdir === '' ? null : subdir],
      );
      const row = created.rows[0]!;
      await client.query(
        `INSERT INTO import_steps (import_id, step, position, status, started_at, finished_at)
         SELECT $1, step, ord, CASE WHEN ord <= 3 THEN 'succeeded' ELSE 'pending' END,
                CASE WHEN ord <= 3 THEN now() END, CASE WHEN ord <= 3 THEN now() END
         FROM unnest($2::text[]) WITH ORDINALITY AS s(step, ord)`,
        [row.id, IMPORT_STEPS],
      );
      const { job } = await enqueueJob(client, {
        type: 'import.process',
        dedupeKey: `import:${row.id}:run:1`,
        payload: { import_id: row.id, config_revision: 0 },
        resourceType: 'import',
        resourceId: row.id,
        ownerId: actorId,
        totalSteps: IMPORT_STEPS.length,
      });
      await writeAudit(client, { actorType: 'user', actorId, action: 'import.created_github', resourceType: 'import', resourceId: row.id, traceId: `github:${commitSha}`, diff: { repo, commit_sha: commitSha } });
      return { importId: row.id, jobId: job.id, commitSha };
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function adminGithubRoutes(app: FastifyInstance): Promise<void> {
  const { db, store, config } = app.deps;

  app.post<{ Body: { repo: string; ref?: string; subdir?: string; rights_confirmed: boolean } }>(
    '/imports/github',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['repo', 'rights_confirmed'], properties: { repo: { type: 'string', maxLength: 200 }, ref: { type: 'string', maxLength: 200 }, subdir: { type: 'string', maxLength: 200 }, rights_confirmed: { type: 'boolean' } } } } },
    async (request, reply) => {
      const auth = requirePermission(request, 'template:import');
      if (request.body.rights_confirmed !== true) throw errors.validation([{ field: 'rights_confirmed', code: 'required' }]);
      const result = await idempotent(
        db,
        { key: request.headers['idempotency-key'], principal: `user:${auth.userId}`, route: 'POST /admin/imports/github', request: request.body },
        async (client) => {
          const created = await createGithubImport(client, store, config, { repo: request.body.repo, ref: request.body.ref, subdir: request.body.subdir, actorId: auth.userId });
          return { status: 202, body: { data: { job_id: created.jobId, resource_id: created.importId, status: 'queued', commit_sha: created.commitSha, progress_url: `/api/v1/jobs/${created.jobId}` } } };
        },
      );
      return reply.status(result.status).send(result.body);
    },
  );

  // GitHub push webhook (AT-57): HMAC-verified, deduped by delivery id, and only for
  // repos the platform has imported before. Creates a new pinned import at head.
  // Note: like the payment webhooks, verification re-serialises the parsed JSON body;
  // a future hardening step is capturing the exact raw bytes at the HTTP layer.
  app.post('/imports/github-webhook', async (request, reply) => {
    const secret = config.githubWebhookSecret;
    if (!secret) throw errors.notFound();
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const delivery = request.headers['x-github-delivery'] as string | undefined;
    const event = request.headers['x-github-event'] as string | undefined;
    if (!signature || !delivery) throw errors.badRequest('github.webhook_invalid');
    const raw = JSON.stringify(request.body ?? {});
    const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw errors.badRequest('github.webhook_invalid');
    const inserted = await db.query(
      'INSERT INTO github_webhook_deliveries (delivery_id, repo, commit_sha) VALUES ($1, $2, $3) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id',
      [delivery, '', ''],
    );
    if (inserted.rowCount === 0) return reply.status(200).send({ received: true, outcome: 'duplicate' });
    const body = request.body as { repository?: { full_name?: string }; head_commit?: { id?: string }; ref?: string };
    if (event !== 'push' || !body.repository?.full_name || !body.head_commit?.id) {
      await db.query('UPDATE github_webhook_deliveries SET repo = $2, commit_sha = $3 WHERE delivery_id = $1', [delivery, body.repository?.full_name ?? '', body.head_commit?.id ?? '']);
      return reply.status(200).send({ received: true, outcome: 'ignored' });
    }
    const repo = body.repository.full_name;
    const prior = await db.query<{ actor_id: string; subdir: string | null }>(
      'SELECT actor_id, subdir FROM imports WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 1',
      [repo],
    );
    if (!prior.rows[0]) {
      await db.query('UPDATE github_webhook_deliveries SET repo = $2, commit_sha = $3 WHERE delivery_id = $1', [delivery, repo, body.head_commit.id]);
      return reply.status(200).send({ received: true, outcome: 'ignored' });
    }
    const headSha = body.head_commit!.id;
    const created = await tx(db, async (client) => createGithubImport(client, store, config, { repo, ref: headSha, subdir: prior.rows[0]!.subdir ?? undefined, actorId: prior.rows[0]!.actor_id }));
    await db.query('UPDATE github_webhook_deliveries SET repo = $2, commit_sha = $3, import_id = $4 WHERE delivery_id = $1', [delivery, repo, body.head_commit.id, created.importId]);
    return reply.status(200).send({ received: true, outcome: 'processed', import_id: created.importId });
  });
}
