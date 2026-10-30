'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { TemplateCard } from '@/components/template-card';
import { CompareTray } from '@/components/compare-tray';
import { api, type ApiError } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { useT } from '@/lib/i18n';
import type { SavedEntry } from '@/lib/saved';

/** ACC-06 — the customer's saved templates. Available ones render as full
 *  catalog cards; ones that stopped selling stay listed with an honest
 *  unavailable note (and a remove action), never a dead buy button. */
export default function SavedTemplatesPage() {
  const { t, locale } = useT();
  const [entries, setEntries] = useState<SavedEntry[] | null>(null);
  const [summaries, setSummaries] = useState<Map<string, TemplateSummary>>(new Map());
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const res = await api<SavedEntry[]>('/me/saved-templates');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEntries(res.data);
    const fetched = new Map<string, TemplateSummary>();
    await Promise.all(
      res.data
        .filter((e) => e.available)
        .map(async (e) => {
          const detail = await api<TemplateSummary>(`/templates/${encodeURIComponent(e.slug)}`);
          if (detail.ok) fetched.set(e.template_id, detail.data);
        }),
    );
    setSummaries(fetched);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const remove = useCallback(async (templateId: string) => {
    const res = await api(`/me/saved-templates/${templateId}`, { method: 'DELETE' });
    if (res.ok) void load();
    else setError(res.error);
  }, [load]);

  if (error && !entries) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!entries) return <Loading />;
  return (
    <div className="stack">
      <h1>{t('ui.saved.title')}</h1>
      <p className="muted" style={{ margin: 0 }}>{t('ui.saved.lead')}</p>
      {entries.length === 0 ? (
        <EmptyState title={t('ui.saved.empty_title')} action={<Link className="button" href={`/${locale}/templates`}>{t('ui.nav.templates')}</Link>}>
          <p>{t('ui.saved.empty_body')}</p>
        </EmptyState>
      ) : (
        <div className="grid-cards">
          {entries.map((entry) => {
            const summary = summaries.get(entry.template_id);
            if (entry.available && summary) return <TemplateCard key={entry.template_id} template={summary} locale={locale} comparable />;
            return (
              <article className="card template-card" key={entry.template_id}>
                <h3 style={{ margin: 0 }}>{entry.slug}</h3>
                <p className="muted" style={{ margin: 0 }}>{t('ui.saved.unavailable')}</p>
                <p style={{ margin: 0 }}>
                  <button type="button" className="button button--secondary" onClick={() => void remove(entry.template_id)}>{t('ui.saved.remove')}</button>
                </p>
              </article>
            );
          })}
        </div>
      )}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      <CompareTray locale={locale} />
    </div>
  );
}
