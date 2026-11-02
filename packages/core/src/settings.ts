import type { Queryable } from './db.ts';

export interface ImportPolicy {
  max_upload_bytes: number;
  max_uncompressed_bytes: number;
  max_files: number;
  max_entry_bytes: number;
  max_compression_ratio: number;
  static_auto_continue: boolean;
  upload_session_ttl_minutes: number;
}

export async function getSetting<T>(db: Queryable, key: string): Promise<T> {
  const { rows } = await db.query<{ value_json: T }>('SELECT value_json FROM settings WHERE key = $1', [key]);
  if (!rows[0]) throw new Error(`setting ${key} missing; run migrations`);
  return rows[0].value_json;
}

export const getImportPolicy = (db: Queryable) => getSetting<ImportPolicy>(db, 'import.policy');
