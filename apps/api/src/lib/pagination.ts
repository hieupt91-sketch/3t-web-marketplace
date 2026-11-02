import { errors } from '../errors.ts';

export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.created_at.toISOString(), id: row.id })).toString('base64url');
}

export function decodeCursor(value: unknown): Cursor | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.t !== 'string' || Number.isNaN(Date.parse(parsed.t)) || !/^[0-9a-f-]{36}$/.test(parsed.id)) throw new Error();
    return parsed;
  } catch {
    throw errors.validation([{ field: 'cursor', code: 'invalid' }]);
  }
}

export function parseLimit(value: unknown): number {
  if (value === undefined) return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw errors.validation([{ field: 'limit', code: 'out_of_range' }]);
  return n;
}

/** Given limit+1 rows ordered by (created_at DESC, id DESC), build the list envelope. */
export function page<T extends { created_at: Date; id: string }, U>(rows: T[], limit: number, map: (row: T) => U) {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { data: slice.map(map), page: { next_cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore } };
}
