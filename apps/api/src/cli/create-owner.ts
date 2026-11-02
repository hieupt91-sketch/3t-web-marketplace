/**
 * Bootstrap the first platform owner (there is no self-service staff signup).
 * Usage: OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' pnpm owner:create
 * The password is read from the environment or prompted, never passed as an argument.
 */
import { createInterface } from 'node:readline/promises';
import { createPool, hashPassword, loadConfig, tx, writeAudit } from '@3t/core';
import { normalizeEmail, passwordIssues } from '../lib/identity.ts';

const config = loadConfig();
const email = normalizeEmail(process.env.OWNER_EMAIL);
if (!email) {
  console.error('Set OWNER_EMAIL to a valid address.');
  process.exit(2);
}
let password = process.env.OWNER_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 12 chars): ');
  rl.close();
}
const issues = passwordIssues(password, email);
if (issues.length) {
  console.error(`Password rejected: ${issues.join(', ')}`);
  process.exit(2);
}
const db = createPool(config.databaseUrl, 1);
try {
  const hash = await hashPassword(password, config.passwordHashCost);
  const userId = await tx(db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email_normalized, display_name, password_hash, verified_at, preferred_locale)
       VALUES ($1, $2, $3, now(), 'vi')
       ON CONFLICT (email_normalized) DO UPDATE SET email_normalized = EXCLUDED.email_normalized
       RETURNING id`,
      [email, process.env.OWNER_NAME ?? 'Platform owner', hash],
    );
    const id = rows[0]!.id;
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'platform_owner' ON CONFLICT DO NOTHING",
      [id],
    );
    await writeAudit(client, { actorType: 'system', actorId: null, action: 'staff.owner_bootstrapped', resourceType: 'user', resourceId: id, traceId: 'cli' });
    return id;
  });
  console.log(JSON.stringify({ status: 'ok', user_id: userId, note: 'Existing accounts keep their password; only the role was granted.' }));
} finally {
  await db.end();
}
