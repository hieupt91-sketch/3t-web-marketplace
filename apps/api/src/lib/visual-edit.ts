import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { extractEditCandidates, type Db, type EditCandidate, type LocalObjectStore } from '@3t/core';
import { isStaticAdapter, versionAdapter } from './template-twin.ts';

/**
 * Visual editor for hosted STATIC sites (phase 2 of the one-time setup
 * model, migration 0046): the second door to the SAME single setup
 * right the order-page form spends (0045). These helpers resolve
 * everything both doors share — the installation service task chained
 * to the site through its entitlement — and prepare the editor's
 * candidate set from the template's own storage:
 *
 *   candidates = (demo seed strings of the DYNAMIC TWIN, whose bundle
 *   carries public/seed.json) ∩ (strings verifiably present in the
 *   STATIC version's frozen HTML).
 *
 * The twin is the catalog's own pairing (slug + '-dong', see
 * template-twin.ts): the static bundle was frozen from that twin's
 * rendering, so its seed is exactly the demo content baked into the
 * static files. No twin / no seed → the editor honestly reports itself
 * unavailable and the buyer keeps the form.
 */

export type VisualEditReason = 'ok' | 'not_static' | 'site_not_active' | 'no_setup_task' | 'already_submitted' | 'no_seed' | 'no_candidates';

export interface SetupTaskContext {
  taskId: string;
  orderId: string;
  submittedAt: Date | null;
}

type DbQuery = { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> };

interface SiteRef {
  id: string;
  entitlement_id: string | null;
  template_version_id: string;
  status: string;
}

/** The installation task that carries the site's one-time setup right:
 *  site → entitlement → order item → order → first installation task
 *  (the same row the order page reads, keyed by order). */
export async function loadSetupTaskContext(db: DbQuery, site: SiteRef): Promise<SetupTaskContext | null> {
  if (!site.entitlement_id) return null;
  const { rows } = await db.query<{ task_id: string; order_id: string; setup_info_submitted_at: Date | null }>(
    `SELECT st.id AS task_id, oi.order_id, st.setup_info_submitted_at
     FROM entitlements e
     JOIN order_items oi ON oi.id = e.order_item_id
     JOIN service_tasks st ON st.order_id = oi.order_id AND st.kind = 'installation'
     WHERE e.id = $1
     ORDER BY st.created_at
     LIMIT 1`,
    [site.entitlement_id],
  );
  const row = rows[0];
  return row ? { taskId: row.task_id, orderId: row.order_id, submittedAt: row.setup_info_submitted_at } : null;
}

async function artifactDir(db: DbQuery, store: LocalObjectStore, versionId: string): Promise<string | null> {
  const { rows } = await db.query<{ object_key: string }>(
    'SELECT a.object_key FROM template_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = $1',
    [versionId],
  );
  return rows[0] ? store.pathFor(rows[0].object_key) : null;
}

/** The published dynamic twin's version id for the site's template. */
async function twinVersionId(db: DbQuery, site: SiteRef): Promise<string | null> {
  const { rows } = await db.query<{ published_version_id: string | null }>(
    `SELECT twin.published_version_id FROM template_versions v
     JOIN templates t ON t.id = v.template_id
     JOIN templates twin ON twin.slug = t.slug || '-dong' AND twin.status = 'published'
     WHERE v.id = $1`,
    [site.template_version_id],
  );
  return rows[0]?.published_version_id ?? null;
}

async function readTwinSeed(db: DbQuery, store: LocalObjectStore, site: SiteRef): Promise<unknown | null> {
  const versionId = await twinVersionId(db, site);
  if (!versionId) return null;
  const dir = await artifactDir(db, store, versionId);
  if (!dir) return null;
  try {
    return JSON.parse(await readFile(join(dir, 'public', 'seed.json'), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function twinSeedExists(db: DbQuery, store: LocalObjectStore, site: SiteRef): Promise<boolean> {
  const versionId = await twinVersionId(db, site);
  if (!versionId) return false;
  const dir = await artifactDir(db, store, versionId);
  return dir !== null && existsSync(join(dir, 'public', 'seed.json'));
}

const MAX_HTML_FILES = 200;
const MAX_CORPUS_BYTES = 8 * 1024 * 1024;

async function collectHtml(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 6 || out.length >= MAX_HTML_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectHtml(full, depth + 1, out);
    else if (/\.html?$/i.test(entry.name)) out.push(full);
  }
}

/** Concatenated HTML of the site's static version artifact — the
 *  ground truth candidate strings are presence-checked against. */
async function readStaticCorpus(db: DbQuery, store: LocalObjectStore, site: SiteRef): Promise<string | null> {
  const dir = await artifactDir(db, store, site.template_version_id);
  if (!dir) return null;
  const files: string[] = [];
  await collectHtml(dir, 0, files);
  if (files.length === 0) return null;
  const parts: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    bytes += text.length;
    if (bytes > MAX_CORPUS_BYTES) break;
    parts.push(text);
  }
  return parts.join('\n');
}

/** Cheap availability for the site detail view (no corpus read: the
 *  seed-existence check is a single stat). */
export async function visualEditAvailability(
  db: Db,
  store: LocalObjectStore,
  site: SiteRef,
): Promise<{ available: boolean; reason: VisualEditReason } | null> {
  const adapter = await versionAdapter(db, site.template_version_id);
  if (!isStaticAdapter(adapter)) return null;
  if (site.status !== 'active' && site.status !== 'grace') return { available: false, reason: 'site_not_active' };
  const task = await loadSetupTaskContext(db, site);
  if (!task) return { available: false, reason: 'no_setup_task' };
  if (task.submittedAt) return { available: false, reason: 'already_submitted' };
  if (!(await twinSeedExists(db, store, site))) return { available: false, reason: 'no_seed' };
  return { available: true, reason: 'ok' };
}

/** Full gate + candidate build for minting an edit session. */
export async function prepareVisualEdit(
  db: Db,
  store: LocalObjectStore,
  site: SiteRef,
): Promise<{ ok: true; task: SetupTaskContext; candidates: EditCandidate[] } | { ok: false; reason: VisualEditReason }> {
  const adapter = await versionAdapter(db, site.template_version_id);
  if (!isStaticAdapter(adapter)) return { ok: false, reason: 'not_static' };
  if (site.status !== 'active' && site.status !== 'grace') return { ok: false, reason: 'site_not_active' };
  const task = await loadSetupTaskContext(db, site);
  if (!task) return { ok: false, reason: 'no_setup_task' };
  if (task.submittedAt) return { ok: false, reason: 'already_submitted' };
  const seed = await readTwinSeed(db, store, site);
  if (seed === null) return { ok: false, reason: 'no_seed' };
  const corpus = await readStaticCorpus(db, store, site);
  if (corpus === null) return { ok: false, reason: 'no_seed' };
  const candidates = extractEditCandidates(seed, corpus);
  if (candidates.length === 0) return { ok: false, reason: 'no_candidates' };
  return { ok: true, task, candidates };
}
