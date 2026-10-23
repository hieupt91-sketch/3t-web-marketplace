import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../app.ts';
import { decodeCursor, page, parseLimit } from '../lib/pagination.ts';

export async function adminCatalogRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // A01: only metrics the platform actually records so far; no placeholder revenue figures.
  app.get('/overview', async (request) => {
    requirePermission(request, 'report:read');
    const [imports, templates, jobs] = await Promise.all([
      db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM imports GROUP BY status'),
      db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM templates GROUP BY status'),
      db.query<{ status: string; n: string }>("SELECT status, count(*) AS n FROM jobs WHERE status IN ('queued', 'running', 'dead') GROUP BY status"),
    ]);
    const toMap = (rows: { status: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    return {
      data: {
        imports_by_status: toMap(imports.rows),
        templates_by_status: toMap(templates.rows),
        jobs_by_status: toMap(jobs.rows),
        generated_at: new Date().toISOString(),
      },
    };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string } }>('/templates', async (request) => {
    requirePermission(request, 'template:read');
    const limit = parseLimit(request.query.limit);
    const cursor = decodeCursor(request.query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (request.query.status && ['draft', 'published', 'archived'].includes(request.query.status)) {
      params.push(request.query.status);
      where.push(`t.status = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await db.query<{
      id: string;
      slug: string;
      status: string;
      created_at: Date;
      updated_at: Date;
      titles: Record<string, string> | null;
      latest_version: { id: string; semver: string; adapter: string; status: string; locales: string[]; import_id: string | null } | null;
      version_count: string;
    }>(
      `SELECT t.id, t.slug, t.status, t.created_at, t.updated_at,
              (SELECT jsonb_object_agg(tt.locale, tt.title) FROM template_translations tt WHERE tt.template_id = t.id) AS titles,
              (SELECT jsonb_build_object('id', v.id, 'semver', v.semver, 'adapter', v.adapter, 'status', v.status,
                                         'locales', v.manifest_json->'locales'->'supported', 'import_id', v.import_id)
               FROM template_versions v WHERE v.template_id = t.id ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
              (SELECT count(*) FROM template_versions v WHERE v.template_id = t.id) AS version_count
       FROM templates t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`,
      params,
    );
    return page(rows, limit, (r) => ({
      id: r.id,
      slug: r.slug,
      status: r.status,
      titles: r.titles ?? {},
      latest_version: r.latest_version,
      version_count: Number(r.version_count),
      prices: [],
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    }));
  });
}
