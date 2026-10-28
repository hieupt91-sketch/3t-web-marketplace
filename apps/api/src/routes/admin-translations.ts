import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../app.ts';

/**
 * Translation workflow matrix (A22/W15): one row per template × locale.
 * Status: missing (no row), draft, reviewed, published, or stale — a
 * published translation is stale when the template was edited after the
 * translation was last saved (template_translations.source_revision is
 * written as 1 on every save upstream, so updated_at comparison is the
 * honest staleness signal available).
 */
export async function adminTranslationRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/translations', async (request) => {
    requirePermission(request, 'template:read');
    const { rows: templates } = await db.query<{ id: string; slug: string; updated_at: Date }>(
      'SELECT id, slug, updated_at FROM templates ORDER BY created_at DESC LIMIT 200',
    );
    const { rows: translations } = await db.query<{ template_id: string; locale: string; status: string; updated_at: Date }>(
      'SELECT template_id, locale, status, updated_at FROM template_translations',
    );
    const byTemplate = new Map<string, typeof translations>();
    for (const t of translations) {
      const list = byTemplate.get(t.template_id) ?? [];
      list.push(t);
      byTemplate.set(t.template_id, list);
    }
    const matrix = templates.map((tpl) => {
      const cells: Record<string, { status: string; updated_at: string | null }> = {};
      for (const locale of ['vi', 'en']) {
        const row = (byTemplate.get(tpl.id) ?? []).find((r) => r.locale === locale);
        if (!row) {
          cells[locale] = { status: 'missing', updated_at: null };
        } else if (row.status === 'published' && new Date(row.updated_at) < new Date(tpl.updated_at)) {
          cells[locale] = { status: 'stale', updated_at: row.updated_at.toISOString() };
        } else {
          cells[locale] = { status: row.status, updated_at: row.updated_at.toISOString() };
        }
      }
      return { template_id: tpl.id, slug: tpl.slug, locales: cells };
    });
    return { data: matrix };
  });
}
