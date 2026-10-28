'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useT } from '@/lib/i18n';
import { api, type ApiError } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { TemplateCard } from '@/components/template-card';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { classifyIntent, type FinderCategory } from '@/lib/finder-intent';

/** Purpose picker cards: same gradients as the old category cards. */
const PURPOSES: { code: FinderCategory; a: string; b: string }[] = [
  { code: 'landing', a: '#1d4ed8', b: '#7c3aed' },
  { code: 'business', a: '#0f766e', b: '#0ea5e9' },
  { code: 'food', a: '#ea580c', b: '#f43f5e' },
  { code: 'realestate', a: '#0284c7', b: '#6366f1' },
  { code: 'store', a: '#db2777', b: '#8b5cf6' },
  { code: 'beauty', a: '#06b6d4', b: '#3b82f6' },
  { code: 'blog', a: '#d97706', b: '#ea580c' },
  { code: 'portfolio', a: '#475569', b: '#8b5cf6' },
];

/**
 * Homepage template-finder assistant: the buyer picks a purpose or types
 * their need in plain words, and matching templates appear inline.
 * Purpose buttons search their category at once; typed needs are classified
 * into a category only on a clear, untied keyword score, otherwise the
 * search falls back to plain keyword search (never a wrong guess). An
 * explicit purpose always wins over inference. Results reuse the public
 * catalog API and TemplateCard, and "view all" opens the same query in the
 * full catalog. Templates are display pages, so the finder also sets that
 * expectation and points admin needs at the detail-page advisor.
 */
export function TemplateFinder() {
  const { t, locale } = useT();
  const [selected, setSelected] = useState<FinderCategory | null>(null);
  const [text, setText] = useState('');
  const [understood, setUnderstood] = useState<FinderCategory | null>(null);
  const [results, setResults] = useState<TemplateSummary[] | null>(null);
  const [lastQuery, setLastQuery] = useState<{ category: string; q: string }>({ category: '', q: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [hint, setHint] = useState(false);

  async function runSearch(category: string, q: string) {
    setLoading(true);
    setError(null);
    setHint(false);
    setLastQuery({ category, q });
    const params = new URLSearchParams({ limit: '24' });
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    const res = await api<TemplateSummary[]>(`/templates?${params}`);
    setLoading(false);
    if (res.ok) setResults(res.data);
    else setError(res.error);
  }

  function pickPurpose(code: FinderCategory) {
    setSelected(code);
    setText('');
    setUnderstood(null);
    void runSearch(code, '');
  }

  function submitText(event: React.FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (!q && !selected) {
      setHint(true);
      return;
    }
    const inferred = q ? classifyIntent(q) : null;
    const category = selected ?? inferred ?? '';
    setUnderstood(!selected && inferred ? inferred : null);
    void runSearch(category, q);
  }

  const allHref = `/${locale}/templates?${new URLSearchParams({ ...(lastQuery.category ? { category: lastQuery.category } : {}), ...(lastQuery.q ? { q: lastQuery.q } : {}) })}`;

  return (
    <section className="stack">
      <h2 style={{ margin: 0 }}>{t('ui.home.purpose_title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('ui.home.purpose_lead')}</p>
      <div className="grid-cards">
        {PURPOSES.map((purpose) => (
          <button
            key={purpose.code}
            type="button"
            className="card category-card"
            aria-pressed={selected === purpose.code}
            style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', ...(selected === purpose.code ? { outline: '2px solid #1d4ed8' } : {}) }}
            onClick={() => pickPurpose(purpose.code)}
          >
            <div className="cat-art" aria-hidden="true" style={{ '--cat-a': purpose.a, '--cat-b': purpose.b } as CSSProperties}>
              <div className="cat-art__dots"><i /><i /><i /></div>
              <div className="cat-art__hero" />
              <div className="cat-art__row"><i /><i /><i /></div>
            </div>
            <h3 style={{ margin: 0 }}>{t(`ui.category.${purpose.code}`)}</h3>
            <p className="muted" style={{ margin: 0 }}>{t(`ui.home.purpose_${purpose.code}`)}</p>
          </button>
        ))}
      </div>
      <form className="search" onSubmit={submitText} role="search">
        <label htmlFor="finder-need" className="visually-hidden">{t('ui.finder.input_label')}</label>
        <input
          id="finder-need"
          className="input"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('ui.finder.input_placeholder')}
        />
        <button className="button" type="submit" disabled={loading}>{loading ? t('ui.state.saving') : t('ui.finder.search')}</button>
      </form>
      {hint ? <p style={{ margin: 0 }}>{t('ui.finder.need_hint')}</p> : null}
      {understood ? <p style={{ margin: 0 }}>{t('ui.finder.understood', { category: t(`ui.category.${understood}`) })}</p> : null}
      {loading ? <Loading /> : null}
      {error ? <ErrorState error={error} onRetry={() => void runSearch(lastQuery.category, lastQuery.q)} /> : null}
      {!loading && !error && results ? (
        results.length === 0 ? (
          <EmptyState title={t('ui.finder.empty')}>
            <p>{t('ui.finder.empty_hint')}</p>
            <p><Link className="button button--secondary" href={`/${locale}/templates`}>{t('ui.home.browse_all')}</Link></p>
          </EmptyState>
        ) : (
          <div className="stack">
            <p className="muted" role="status" style={{ margin: 0 }}>{t('ui.catalog.result_count', { count: String(results.length) })}</p>
            <div className="grid-cards">
              {results.map((template) => <TemplateCard key={template.id} template={template} locale={locale} />)}
            </div>
            <p style={{ margin: 0 }}><Link className="button button--secondary" href={allHref}>{t('ui.finder.all_results')}</Link></p>
          </div>
        )
      ) : null}
      <p className="muted" style={{ margin: 0 }}>{t('ui.finder.note_display')}</p>
    </section>
  );
}
