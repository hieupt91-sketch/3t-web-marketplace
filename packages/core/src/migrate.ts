import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './config.ts';
import { tx, type Db } from './db.ts';

export const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only migration runner. Each file runs in its own transaction under an advisory lock;
 * checksums detect edits to already-applied migrations (which must never happen).
 */
export async function migrate(pool: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  await tx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(727274001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const known = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const version = file.replace(/\.sql$/, '');
      const existing = known.get(version);
      if (existing !== undefined) {
        if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        alreadyApplied.push(version);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
      applied.push(version);
    }
  });
  return { applied, alreadyApplied };
}
