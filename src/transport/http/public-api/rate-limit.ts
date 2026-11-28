import type { Pool } from "pg";

// Browser views can fan out into several reads for one interaction. A read
// spends one unit of the shared general budget and ordinary requests spend
// five, preserving the public API's 120/min and the browser write allowance.
const generalRequestCost = 5;
const perMinute = { general: 120 * generalRequestCost, validate: 12, publish: 6, upload: 30 } as const;
export type RateBucket = keyof typeof perMinute;

// A single bounded row per account and bucket keeps counters shared across
// replicas. Database time makes each replica use the same fixed minute window.
async function charge(
  pool: Pool,
  actorId: string,
  bucket: RateBucket,
  kind: "ordinary" | "browser_read",
): Promise<{ windowAt: Date } | null> {
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
     RETURNING window_at`,
    [actorId, bucket, perMinute[bucket], cost],
  );
  return result.rowCount === 1 ? { windowAt: result.rows?.[0]?.window_at as Date } : null;
}

/**
 * Charges the operation's own bucket and the shared general budget as
 * separate budgets (design Section 14). The specific bucket is checked first,
 * so a request it rejects spends nothing from the general budget. When the
 * general budget then rejects the request, the specific charge is refunded
 * in the same minute window.
 */
export async function consumeRequestBudgets(
  pool: Pool,
  actorId: string,
  kind: "ordinary" | "browser_read",
  bucket?: Exclude<RateBucket, "general">,
): Promise<boolean> {
  const specific = bucket === undefined ? undefined : await charge(pool, actorId, bucket, kind);
  if (specific === null) return false;
  if (await charge(pool, actorId, "general", kind) !== null) return true;
  if (specific !== undefined && bucket !== undefined) {
    await pool.query(
      `WITH locked_bucket AS MATERIALIZED (
         SELECT hits FROM public_api_rate_limits
         WHERE user_id = $1 AND bucket = $2 AND window_at = $3
         FOR UPDATE
       ), deleted AS (
         DELETE FROM public_api_rate_limits
         WHERE user_id = $1 AND bucket = $2 AND window_at = $3
           AND (SELECT hits FROM locked_bucket) = 1
         RETURNING user_id
       )
       UPDATE public_api_rate_limits SET hits = hits - 1
       WHERE user_id = $1 AND bucket = $2 AND window_at = $3
         AND (SELECT hits FROM locked_bucket) > 1`,
      [actorId, bucket, specific.windowAt],
    );
  }
  return false;
}
