import type { Pool } from "pg";

const perMinute = { general: 120, validate: 12, publish: 6, upload: 30 } as const;
export type RateBucket = keyof typeof perMinute;

// A single bounded row per account and bucket keeps counters shared across
// replicas. Database time makes each replica use the same fixed minute window.
export async function consumeRequest(pool: Pool, actorId: string, bucket: RateBucket): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO public_api_rate_limits (user_id, bucket, window_at, hits)
     VALUES ($1, $2, date_trunc('minute', statement_timestamp()), 1)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       window_at = EXCLUDED.window_at,
       hits = CASE WHEN public_api_rate_limits.window_at < EXCLUDED.window_at
                   THEN 1 ELSE public_api_rate_limits.hits + 1 END
     WHERE public_api_rate_limits.window_at < EXCLUDED.window_at
        OR (public_api_rate_limits.window_at = EXCLUDED.window_at AND public_api_rate_limits.hits < $3)
     RETURNING hits`,
    [actorId, bucket, perMinute[bucket]],
  );
  return result.rowCount === 1;
}
