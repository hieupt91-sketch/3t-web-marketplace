let childCounter = 0;

/**
 * Postgres-backed rate-limit store for @fastify/rate-limit (M1 debt).
 * The plugin constructs the store with global params only, so the database
 * handle is bound by subclassing in app.ts (see PgRateLimitStore.create).
 * Like the plugin's LocalStore (a fresh instance per route), child() returns
 * a store with a fresh namespace: the plugin's key is just the client IP,
 * so routes must not share a bucket. The window upsert is a single atomic
 * statement, so every API instance counts against the same rows.
 */
export class PgRateLimitStore {
  constructor(
    private readonly db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
    private readonly namespace: string,
  ) {}

  static create(db: PgRateLimitStore['db']): new () => PgRateLimitStore {
    return class extends PgRateLimitStore {
      constructor() {
        super(db, 'global');
      }
    };
  }

  child(_routeOptions: unknown): PgRateLimitStore {
    // One namespace per child() call = one bucket set per route, matching
    // LocalStore semantics. The argument carries merged params, not a route
    // path, so deriving the namespace from it would collapse all routes
    // into a single bucket (observed as spurious 429s across auth routes).
    childCounter += 1;
    return new PgRateLimitStore(this.db, `route-${childCounter}`);
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow?: number,
  ): void {
    const windowMs = typeof timeWindow === 'number' && timeWindow > 0 ? timeWindow : 60000;
    const now = Date.now();
    const namespaced = `${this.namespace}:${key}`;
    this.db
      .query<{ window_start_ms: string; count: string }>(
        `INSERT INTO rate_limit_buckets (key, window_start_ms, count) VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           window_start_ms = CASE WHEN rate_limit_buckets.window_start_ms + $3 <= $2 THEN $2 ELSE rate_limit_buckets.window_start_ms END,
           count = CASE WHEN rate_limit_buckets.window_start_ms + $3 <= $2 THEN 1 ELSE rate_limit_buckets.count + 1 END
         RETURNING window_start_ms, count`,
        [namespaced, now, windowMs],
      )
      .then(({ rows }) => {
        const row = rows[0]!;
        const ttl = Math.max(0, windowMs - (now - Number(row.window_start_ms)));
        callback(null, { current: Number(row.count), ttl });
      })
      .catch((error: Error) => callback(error));
  }
}

/** Fixed-window check for hand-rolled limiters (Partner API keys). */
export async function checkDbRateLimit(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  const { rows } = await db.query<{ window_start_ms: string; count: string }>(
    `INSERT INTO rate_limit_buckets (key, window_start_ms, count) VALUES ($1, $2, 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start_ms = CASE WHEN rate_limit_buckets.window_start_ms + $3 <= $2 THEN $2 ELSE rate_limit_buckets.window_start_ms END,
       count = CASE WHEN rate_limit_buckets.window_start_ms + $3 <= $2 THEN 1 ELSE rate_limit_buckets.count + 1 END
     RETURNING window_start_ms, count`,
    [key, now, windowMs],
  );
  const row = rows[0]!;
  const count = Number(row.count);
  const retryAfterSeconds = Math.ceil(Math.max(0, windowMs - (now - Number(row.window_start_ms))) / 1000);
  return { allowed: count <= limit, retryAfterSeconds };
}
