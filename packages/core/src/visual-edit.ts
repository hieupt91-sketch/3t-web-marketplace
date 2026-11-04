/**
 * Visual editor for hosted STATIC sites (phase 2 of the one-time setup
 * model, migration 0046). A static bundle was frozen from a dynamic
 * template whose seed content is known, so the buyer's single setup
 * right can be spent clicking the live page instead of filling the
 * order-page form: the seed strings (business identity, product/service
 * names + prices, images) become the replaceable candidates.
 *
 * This module is the pure, shared core of that flow — the API uses it
 * to extract candidates at session-mint time, the site router carries
 * the snapshot, and the worker uses the very same match/replace rules
 * to rewrite the site's files, so what the buyer saw highlighted is
 * exactly what gets replaced. A candidate is only offered when its
 * string is verifiably present in the static bundle's HTML.
 */

export interface EditCandidate {
  /** Seed path, e.g. 'site.name', 'menu.items.0.name', 'hero.image'. */
  id: string;
  kind: 'text' | 'image';
  /** Current demo values (a bilingual leaf may carry either or both). */
  vi?: string;
  en?: string;
  /** For kind 'image': the URL/path exactly as it appears in the HTML. */
  url?: string;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A bilingual leaf is an object with vi/en string props; a plain leaf
 *  is a bare string. Returns null for anything else. */
function leafStrings(v: unknown): { vi?: string; en?: string } | null {
  if (typeof v === 'string') return { vi: v };
  if (isRecord(v)) {
    const vi = typeof v.vi === 'string' ? v.vi : undefined;
    const en = typeof v.en === 'string' ? v.en : undefined;
    if (vi !== undefined || en !== undefined) return { vi, en };
  }
  return null;
}

/** Strings shorter than this are never offered: replacing a 1–2 char
 *  string across a whole page would corrupt unrelated content. */
const MIN_TEXT_LENGTH = 3;

function pushText(out: EditCandidate[], id: string, leaf: { vi?: string; en?: string }): void {
  const vi = leaf.vi?.trim() ? leaf.vi : undefined;
  const en = leaf.en?.trim() ? leaf.en : undefined;
  if ((vi ?? '').length < MIN_TEXT_LENGTH && (en ?? '').length < MIN_TEXT_LENGTH) return;
  out.push({ id, kind: 'text', ...(vi ? { vi } : {}), ...(en ? { en } : {}) });
}

/** Walk every string/localized leaf under a seed section (site, hero,
 *  about, footer…), turning each into a text candidate; `image` leaves
 *  become image candidates. */
function walkSection(out: EditCandidate[], seed: Json, section: string, base: string): void {
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}.${i}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, v] of Object.entries(value)) {
      const p = `${path}.${key}`;
      if (key === 'image' && typeof v === 'string' && v.trim()) {
        out.push({ id: p, kind: 'image', url: v });
        continue;
      }
      const leaf = leafStrings(v);
      if (leaf) {
        pushText(out, p, leaf);
        continue;
      }
      walk(v, p);
    }
  };
  walk(seed[section], base);
}

const PRICE_KEY = /price|gia/i;

/** Product/service arrays anywhere in the seed (menu.items,
 *  spaces.items, services…): an item's name/title, price leaves and
 *  image become candidates. Item descriptions stay read-only in v1 —
 *  the owner-scoped editable set is identity + names + prices + images. */
function walkArrays(out: EditCandidate[], value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const p = `${path}.${i}`;
      if (isRecord(item)) {
        for (const [key, v] of Object.entries(item)) {
          if (key === 'name' || key === 'title' || PRICE_KEY.test(key)) {
            const leaf = leafStrings(v);
            if (leaf) pushText(out, `${p}.${key}`, leaf);
          } else if (key === 'image' && typeof v === 'string' && v.trim()) {
            out.push({ id: `${p}.image`, kind: 'image', url: v });
          }
        }
      }
      walkArrays(out, item, p);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, v] of Object.entries(value)) walkArrays(out, v, path ? `${path}.${key}` : key);
  }
}

/** Sections that are template chrome, not buyer business content. */
const SKIP_SECTIONS = new Set(['ui', 'theme', 'seo', 'nav', 'bookingForm']);

export function extractEditCandidates(seed: unknown, corpus: string): EditCandidate[] {
  if (!isRecord(seed)) return [];
  const raw: EditCandidate[] = [];
  for (const section of ['site', 'hero', 'about', 'footer']) {
    if (isRecord(seed[section])) walkSection(raw, seed, section, section);
  }
  for (const [key, v] of Object.entries(seed)) {
    if (SKIP_SECTIONS.has(key) || key === 'site' || key === 'hero' || key === 'about' || key === 'footer') continue;
    walkArrays(raw, v, key);
  }
  const seen = new Set<string>();
  const out: EditCandidate[] = [];
  for (const c of raw) {
    const key = `${c.kind}|${c.vi ?? ''}|${c.en ?? ''}|${c.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!candidatePresent(c, corpus)) continue;
    out.push(c);
  }
  return out;
}

/** The HTML-escaped form of a string, as a renderer would emit it into
 *  text or a double-quoted attribute. Match/replace always consider the
 *  raw and escaped forms so a seed string is found wherever it landed. */
export function escapeHtmlForm(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Distinct match forms of a string, most specific (escaped) first. */
export function matchForms(s: string): string[] {
  const escaped = escapeHtmlForm(s);
  return escaped === s ? [s] : [escaped, s];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function candidatePresent(candidate: EditCandidate, corpus: string): boolean {
  if (candidate.kind === 'image') return candidate.url !== undefined && corpus.includes(candidate.url);
  return [candidate.vi, candidate.en].some((v) => v !== undefined && matchForms(v).some((f) => corpus.includes(f)));
}

export interface ReplacementPair {
  from: string;
  to: string;
}

/**
 * Apply exact-match replacements to one file's content. Pairs run
 * longest-`from` first so a short string cannot eat part of a longer
 * one; within a pair the escaped form is replaced before the raw form.
 * Returns the new content and, per input pair (original order), how
 * many occurrences were replaced.
 */
export function applyReplacements(content: string, pairs: ReplacementPair[]): { content: string; counts: number[] } {
  const order = pairs.map((pair, index) => ({ pair, index })).sort((a, b) => b.pair.from.length - a.pair.from.length);
  const counts = new Array<number>(pairs.length).fill(0);
  let out = content;
  for (const { pair, index } of order) {
    if (!pair.from || pair.from === pair.to) continue;
    for (const form of matchForms(pair.from)) {
      const n = countOccurrences(out, form);
      if (n > 0) {
        out = out.split(form).join(form === pair.from ? pair.to : escapeHtmlForm(pair.to));
        counts[index] = (counts[index] ?? 0) + n;
      }
    }
  }
  return { content: out, counts };
}

/** Total occurrences of a string's match forms in a corpus (used by
 *  the worker to tell "already applied" from "never matched"). */
export function countForms(corpus: string, s: string): number {
  return matchForms(s).reduce((sum, f) => sum + countOccurrences(corpus, f), 0);
}
