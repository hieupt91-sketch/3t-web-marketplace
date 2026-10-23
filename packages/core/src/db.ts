import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'>;

// bigint (int8) and numeric are returned as strings to avoid float precision loss (docs/02 §4).
pg.types.setTypeParser(20, (v) => v);

export function createPool(databaseUrl: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, application_name: '3t-marketplace' });
  pool.on('error', () => {
    // Idle client errors are surfaced on next query; avoid crashing the process here.
  });
  return pool;
}

/** Run `fn` inside a transaction; rolls back on any thrown error. */
export async function tx<T>(pool: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
export type { PoolClient } from 'pg';
