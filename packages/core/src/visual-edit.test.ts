import { describe, expect, it } from 'vitest';
import { applyReplacements, escapeHtmlForm, extractEditCandidates } from './visual-edit.ts';

/** Candidate extraction + replacement rules shared by the API (mint),
 *  the router (finalize validation) and the worker (rewrite) for the
 *  static visual editor (migration 0046). */
const SEED = {
  site: {
    name: { vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' },
    phone: '0967 136 099',
    email: 'lien-he@vi-du.vn',
    tagline: 'OK',
  },
  hero: { image: 'images/hero.jpg', headline: { vi: 'Phụ tùng chính hãng', en: 'Genuine parts' } },
  menu: {
    items: [
      { name: { vi: 'Lọc dầu động cơ', en: 'Engine oil filter' }, price: '250.000₫', desc: { vi: 'Mô tả dài không sửa ở v1 này', en: 'Long desc' }, image: 'images/oil.jpg' },
      { name: { vi: 'Lọc dầu động cơ', en: 'Engine oil filter' }, price: '250.000₫' },
    ],
  },
  ui: { bookNow: { vi: 'Đặt lịch ngay', en: 'Book now' } },
  seo: { title: { vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' } },
};
const CORPUS = [
  '<title>Phụ Tùng Ô Tô Trường Sơn</title>',
  '<p data-en="Truong Son Auto Parts">Phụ Tùng Ô Tô Trường Sơn</p>',
  '<p>Hotline: 0967 136 099</p>',
  '<img src="images/hero.jpg">',
  '<h3>Lọc dầu động cơ</h3><span>250.000₫</span>',
  '<p>Đặt lịch ngay</p>',
].join('\n');

describe('extractEditCandidates', () => {
  it('keeps only candidates verifiably present in the static HTML', () => {
    const ids = extractEditCandidates(SEED, CORPUS).map((c) => c.id).sort();
    // site.email, hero.headline and about-style absent strings are out;
    // ui.* chrome is out even though present; too-short strings are out.
    expect(ids).toEqual(['hero.image', 'menu.items.0.name', 'menu.items.0.price', 'site.name', 'site.phone']);
  });

  it('dedupes identical items and carries both locales + image urls', () => {
    const all = extractEditCandidates(SEED, CORPUS);
    const name = all.find((c) => c.id === 'site.name');
    expect(name).toEqual({ id: 'site.name', kind: 'text', vi: 'Phụ Tùng Ô Tô Trường Sơn', en: 'Truong Son Auto Parts' });
    const image = all.find((c) => c.id === 'hero.image');
    expect(image).toEqual({ id: 'hero.image', kind: 'image', url: 'images/hero.jpg' });
    expect(all.filter((c) => c.vi === 'Lọc dầu động cơ').length).toBe(1);
  });

  it('matches the HTML-escaped form of a seed string too', () => {
    const seed = { site: { name: { vi: 'Café & Bar', en: 'Café & Bar' } } };
    const all = extractEditCandidates(seed, '<p>Café &amp; Bar</p>');
    expect(all.map((c) => c.id)).toEqual(['site.name']);
  });

  it('returns [] for non-object seeds', () => {
    expect(extractEditCandidates(null, CORPUS)).toEqual([]);
    expect(extractEditCandidates('nope', CORPUS)).toEqual([]);
  });
});

describe('applyReplacements', () => {
  it('replaces all occurrences, raw and escaped forms, longest pair first', () => {
    const content = '<p>Café &amp; Bar — Café & Bar</p><h1>Phụ Tùng Ô Tô Trường Sơn</h1><p>Trường Sơn</p>';
    const { content: out, counts } = applyReplacements(content, [
      { from: 'Trường Sơn', to: 'TS' },
      { from: 'Phụ Tùng Ô Tô Trường Sơn', to: 'Phụ Tùng Minh Phát' },
      { from: 'Café & Bar', to: 'Minh & Phát' },
    ]);
    // Longest-first: the full-name pair runs before the short pair can
    // eat the tail of the full name (the short pair then only claims
    // the standalone occurrence).
    expect(counts).toEqual([1, 1, 2]);
    expect(out).toBe('<p>Minh &amp; Phát — Minh & Phát</p><h1>Phụ Tùng Minh Phát</h1><p>TS</p>');
  });

  it('skips identity pairs and reports zeroes for misses', () => {
    const { content, counts } = applyReplacements('abc', [
      { from: 'abc', to: 'abc' },
      { from: 'zzz', to: 'q' },
    ]);
    expect(content).toBe('abc');
    expect(counts).toEqual([0, 0]);
  });

  it('escapeHtmlForm escapes the attribute-relevant characters', () => {
    expect(escapeHtmlForm('a & "b" <c>')).toBe('a &amp; &quot;b&quot; &lt;c&gt;');
  });
});
