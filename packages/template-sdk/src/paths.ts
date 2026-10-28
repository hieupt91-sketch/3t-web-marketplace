/**
 * Archive entry path normalisation (docs/03 §6 — Zip Slip defence).
 * Paths are interpreted with both POSIX and Windows separators; anything that could
 * resolve outside the extraction root is rejected rather than "fixed".
 */

export type PathRejection =
  | 'empty'
  | 'control_character'
  | 'absolute'
  | 'drive_letter'
  | 'parent_segment'
  | 'windows_reserved';

export type NormalizedPath = { ok: true; path: string; isDirectory: boolean } | { ok: false; reason: PathRejection };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function normalizeEntryPath(raw: string): NormalizedPath {
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'control_character' };
  const unified = raw.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(unified)) return { ok: false, reason: 'drive_letter' };
  if (unified.startsWith('/')) return { ok: false, reason: 'absolute' };
  const isDirectory = unified.endsWith('/');
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, reason: 'parent_segment' };
    if (WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment)) return { ok: false, reason: 'windows_reserved' };
    segments.push(segment.normalize('NFC'));
  }
  if (segments.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, path: segments.join('/'), isDirectory };
}

/** Key used to detect entries that collide after normalisation on case-insensitive filesystems. */
export function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** Validate a relative path supplied by a manifest or an admin form (same rules as archive entries). */
export function isSafeRelativePath(value: string): boolean {
  if (value === '.') return true;
  const result = normalizeEntryPath(value);
  return result.ok && !value.includes('\\');
}

export function joinRelative(root: string, path: string): string {
  if (root === '.' || root === '') return path;
  return `${root.replace(/\/+$/, '')}/${path}`;
}
