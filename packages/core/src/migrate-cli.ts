import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { migrate } from './migrate.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 1);
try {
  const result = await migrate(pool);
  console.log(JSON.stringify({ status: 'ok', ...result }));
} finally {
  await pool.end();
}
