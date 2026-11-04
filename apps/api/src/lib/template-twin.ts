import type { Queryable } from '@3t/core';

/** Static adapters ship plain files with no runtime and no site admin:
 *  the buyer can never edit content after delivery (docs: template-kind).
 *  Dynamic adapters (node-http / next-standalone) run a server + admin. */
export const STATIC_ADAPTERS: ReadonlySet<string> = new Set(['static-html', 'vite-static']);

export function isStaticAdapter(adapter: string | null | undefined): boolean {
  return adapter != null && STATIC_ADAPTERS.has(adapter);
}

/** The adapter of one template version (template_versions.adapter is the
 *  canonical column route code reads, e.g. sites.ts loadDynamicSite). */
export async function versionAdapter(db: Queryable, versionId: string): Promise<string | null> {
  const { rows } = await db.query<{ adapter: string }>('SELECT adapter FROM template_versions WHERE id = $1', [versionId]);
  return rows[0]?.adapter ?? null;
}

/**
 * The dynamic twin of a template, by the catalog's slug convention: the
 * twin shares the design and its slug is the canonical slug + '-dong'
 * (verified across the whole published catalog). Only a published,
 * non-hidden twin counts — anything else is not buyable, so it cannot be
 * offered as the way out of a static purchase.
 */
export async function findDynamicTwin(db: Queryable, templateId: string): Promise<{ id: string; slug: string } | null> {
  const { rows } = await db.query<{ id: string; slug: string }>(
    `SELECT twin.id, twin.slug FROM templates t
     JOIN templates twin ON twin.slug = t.slug || '-dong'
     WHERE t.id = $1 AND twin.status = 'published' AND NOT twin.hidden`,
    [templateId],
  );
  return rows[0] ?? null;
}
