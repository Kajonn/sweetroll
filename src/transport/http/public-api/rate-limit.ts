import type { Pool } from "pg";

// Browser views can fan out into several reads for one interaction. A read
// spends one unit of the shared general budget and ordinary requests spend
// five, preserving the public API's 120/min and the browser write allowance.
const generalRequestCost = 5;
const perMinute = { general: 120 * generalRequestCost, validate: 12, publish: 6, upload: 30 } as const;
export type RateBucket = keyof typeof perMinute;

// A single bounded row per account and bucket keeps counters shared across
// replicas. Database time makes each replica use the same fixed minute window.
export async function consumeRequest(
  pool: Pool,
  actorId: string,
  bucket: RateBucket,
  kind: "ordinary" | "browser_read" = "ordinary",
): Promise<boolean> {
  const cost = bucket === "general" && kind === "ordinary" ? generalRequestCost : 1;
  const result = await pool.query(
    `INSERT INTO public_api_rate_limits (user_id, bucket, window_at, hits)
     VALUES ($1, $2, date_trunc('minute', statement_timestamp()), $4)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       window_at = EXCLUDED.window_at,
       hits = CASE WHEN public_api_rate_limits.window_at < EXCLUDED.window_at
                   THEN EXCLUDED.hits ELSE public_api_rate_limits.hits + EXCLUDED.hits END
     WHERE public_api_rate_limits.window_at < EXCLUDED.window_at
        OR (public_api_rate_limits.window_at = EXCLUDED.window_at
            AND public_api_rate_limits.hits + EXCLUDED.hits <= $3)
     RETURNING hits`,
    [actorId, bucket, perMinute[bucket], cost],
  );
  return result.rowCount === 1;
}
