import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Db } from './db.ts';
import { migrate } from './migrate.ts';

/**
 * Creates an isolated, migrated database per test file. Requires an admin URL able to
 * CREATE/DROP DATABASE (default: local dev cluster from scripts/dev-db.sh).
 */
export async function createTestDatabase(): Promise<{ pool: Db; url: string; drop: () => Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
  const name = `mp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 5);
  await migrate(pool);
  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
