import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, createUser, type TestContext } from '../../apps/api/src/test-helpers.ts';
import { sweepExpiredReservations } from '@3t/worker/site-jobs';

/** DEP-06 worker hygiene: the periodic sweep bulk-releases expired holds
 *  so the table stays honest even for names nobody checks again. */
let ctx: TestContext;
let userId = '';

beforeAll(async () => {
  ctx = await createTestContext();
  const user = await createUser(ctx, 'sweep@example.com');
  userId = user.id;
  await ctx.db.query(
    `INSERT INTO subdomain_reservations (subdomain, user_id, expires_at) VALUES
       ('sweep-old', $1, now() - interval '5 minutes'),
       ('sweep-live', $1, now() + interval '5 minutes')`,
    [userId],
  );
});
afterAll(async () => ctx.close());

describe('subdomain reservation sweep', () => {
  it('expires only overdue active holds and is idempotent', async () => {
    expect(await sweepExpiredReservations(ctx.db)).toBe(1);
    const { rows } = await ctx.db.query<{ subdomain: string; status: string }>(
      "SELECT subdomain, status FROM subdomain_reservations WHERE user_id = $1 ORDER BY subdomain",
      [userId],
    );
    expect(rows).toEqual([
      { subdomain: 'sweep-live', status: 'active' },
      { subdomain: 'sweep-old', status: 'expired' },
    ]);
    expect(await sweepExpiredReservations(ctx.db)).toBe(0);
  });
});
