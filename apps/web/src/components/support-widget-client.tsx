'use client';

import { useState } from 'react';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { api, type ApiError } from '@/lib/api';
import type { TemplateSummary } from '@/lib/api-server';
import { ErrorState, Loading } from '@/components/ui';
import { classifyIntent, FINDER_CATEGORIES, type FinderCategory } from '@/lib/finder-intent';

export interface ContactChannels {
  phone: string | null;
  zalo: string | null;
  messenger: string | null;
  email: string | null;
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, '')}`;
}

/**
 * HELP-05: the single floating support button (bottom right). Its panel
 * holds BOTH things the old two widgets did separately — every contact
 * channel configured in admin (call / Zalo / Messenger / email / form)
 * and the quick template finder — so a visitor never has to guess which
 * bubble does what. Opening the panel never sends anything anywhere
 * (docs/12 §13): channels are plain links, and the finder only searches
 * when the visitor picks a purpose or submits words.
 */
export function SupportWidgetClient({ locale, contact }: { locale: Locale; contact: ContactChannels }) {
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
    <div className="support-widget">
      {open ? (
        <div className="card support-widget__panel stack" role="dialog" aria-label={t('ui.support.title')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{t('ui.support.title')}</strong>
            <button type="button" className="button button--secondary" onClick={() => setOpen(false)}>{t('ui.quick.close')}</button>
          </div>
          <nav className="stack" aria-label={t('ui.contact.widget_title')} style={{ gap: 'var(--space-2)' }}>
            {contact.phone ? <a className="button button--secondary" href={telHref(contact.phone)}>{t('ui.contact.call')}: {contact.phone}</a> : null}
            {contact.zalo ? <a className="button button--secondary" href={`https://zalo.me/${encodeURIComponent(contact.zalo)}`} target="_blank" rel="noopener noreferrer nofollow">{t('ui.contact.zalo_chat')}</a> : null}
            {contact.messenger ? <a className="button button--secondary" href={`https://m.me/${encodeURIComponent(contact.messenger)}`} target="_blank" rel="noopener noreferrer nofollow">{t('ui.contact.messenger_chat')}</a> : null}
            {contact.email ? <a className="button button--secondary" href={`mailto:${contact.email}`}>{contact.email}</a> : null}
            <a className="button" href={`/${locale}/contact`}>{t('ui.contact.form_link')}</a>
          </nav>
          <hr style={{ margin: 0, border: 'none', borderTop: '1px solid var(--color-border)' }} />
          <strong>{t('ui.quick.title')}</strong>
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
            <label htmlFor="support-need" className="visually-hidden">{t('ui.finder.input_label')}</label>
            <input
              id="support-need"
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
        className="button support-widget__button"
        aria-label={open ? t('ui.quick.close') : t('ui.support.open')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="26" height="26"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /></svg>
      </button>
    </div>
  );
}
