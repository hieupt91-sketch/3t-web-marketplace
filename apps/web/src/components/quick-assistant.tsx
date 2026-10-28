'use client';

import { useState } from 'react';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { api, type ApiError } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { ErrorState, Loading } from '@/components/ui';
import { classifyIntent, FINDER_CATEGORIES, type FinderCategory } from '@/lib/finder-intent';

/**
 * Quick-advice assistant icon: a floating bubble on every page (bottom
 * left, so it never covers the contact widget at bottom right). Tapping
 * it opens a compact version of the homepage finder: pick a purpose or
 * type a need in plain words, and matching templates appear at once.
 * Same conservative rules as the finder: an explicit purpose always wins,
 * typed needs are classified only on a clear untied score, otherwise the
 * search falls back to plain keywords (never a wrong guess). The full
 * 5-question advisor stays on the template detail page; this panel is
 * only for finding the right template fast. Result links close the panel
 * because the root layout persists across navigation.
 */
export function QuickAssistant({ locale }: { locale: Locale }) {
  const t = (key: string, params?: Record<string, string>) => translate(locale, key, params);
  const [open, setOpen] = useState(false);
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
    <div className="quick-assistant">
      {open ? (
        <div className="card quick-assistant__panel stack" role="dialog" aria-label={t('ui.quick.title')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{t('ui.quick.title')}</strong>
            <button type="button" className="button button--secondary" onClick={() => setOpen(false)}>{t('ui.quick.close')}</button>
          </div>
          <div className="row">
            {FINDER_CATEGORIES.map((code) => (
              <button
                key={code}
                type="button"
                className="button button--secondary"
                aria-pressed={selected === code}
                onClick={() => pickPurpose(code)}
              >
                {t(`ui.category.${code}`)}
              </button>
            ))}
          </div>
          <form className="search" onSubmit={submitText} role="search">
            <label htmlFor="quick-need" className="visually-hidden">{t('ui.finder.input_label')}</label>
            <input
              id="quick-need"
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
              <div>
                <p style={{ margin: 0 }}>{t('ui.finder.empty')}</p>
                <p className="muted" style={{ margin: 0 }}>{t('ui.finder.empty_hint')}</p>
              </div>
            ) : (
              <div className="stack">
                <ul style={{ margin: 0 }}>
                  {results.map((template) => (
                    <li key={template.id}>
                      <Link href={`/${locale}/templates/${template.slug}`} onClick={() => setOpen(false)}>{template.title}</Link>
                    </li>
                  ))}
                </ul>
                <p style={{ margin: 0 }}><Link className="button button--secondary" href={allHref} onClick={() => setOpen(false)}>{t('ui.finder.all_results')}</Link></p>
              </div>
            )
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="button quick-assistant__button"
        aria-label={open ? t('ui.quick.close') : t('ui.quick.open')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="26" height="26"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /></svg>
      </button>
    </div>
  );
}
