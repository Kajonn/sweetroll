import type { Logger } from "pino";
import type { Pool } from "pg";

/**
 * Retention for rows that expire logically (issue #62, design 12.3/13.1).
 *
 * Each rule deletes only rows the owning code already treats as unusable,
 * and only once they have stayed unusable for a grace period. The grace
 * period keeps expired idempotency records answering "replay expired" /
 * "result unavailable" for a while after expiry instead of letting a late
 * retry execute again, and absorbs client/server clock differences.
 *
 * Never pruned here: audit, activity, rolls, characters, campaigns, content,
 * media, consumed (accepted/declined) or revoked invitations, and anything
 * else holding user content or history.
 */
export const PRUNE_TABLES = [
  "idempotency_receipts",
  "preview_snapshots",
  "character_command_executions",
  "campaign_command_executions",
  "character_image_receipts",
  "item_image_receipts",
  "sessions",
  "personal_access_tokens",
  "campaign_invitations",
  "display_codes",
] as const;

export type PruneTable = (typeof PRUNE_TABLES)[number];

/** `$1` is the cutoff: now minus the grace period. */
const PRUNE_CONDITIONS: Record<PruneTable, string> = {
  // System authoring receipts: lookups already ignore expired rows.
  idempotency_receipts: "expires_at < $1",
  // Preview snapshots: loads already ignore expired rows.
  preview_snapshots: "expires_at < $1",
  // Completed executions past their replay window, and abandoned pending
  // claims whose lease and provisional replay window have both lapsed.
  // A live lease (in-progress command) is never touched.
  character_command_executions:
    "expires_at < $1 AND (status = 'completed' OR lease_expires_at < $1)",
  campaign_command_executions: "expires_at < $1",
  character_image_receipts: "expires_at < $1",
  item_image_receipts: "expires_at < $1",
  // Sessions and tokens stop authenticating at expiry or revocation.
  sessions: "LEAST(expires_at, COALESCE(revoked_at, 'infinity'::timestamptz)) < $1",
  personal_access_tokens: "LEAST(expires_at, COALESCE(revoked_at, 'infinity'::timestamptz)) < $1",
  // Only never-consumed invitations past expiry. Accepted, declined and
  // revoked invitations are membership history and back replay checks.
  campaign_invitations: "status = 'pending' AND expires_at < $1",
  display_codes: "expires_at < $1",
};

/** Session-level advisory lock key shared by every replica. */
export const PRUNE_LOCK_NAME = "sweetroll:prune-expired-rows";

export const DEFAULT_PRUNE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PRUNE_BATCH_SIZE = 1000;
export const DEFAULT_PRUNE_TIME_BUDGET_MS = 30_000;

export type PruneOptions = {
  now?: Date;
  graceMs?: number;
  batchSize?: number;
  timeBudgetMs?: number;
};

export type PruneResult =
  | { skipped: true }
  | {
      skipped: false;
      deleted: Record<PruneTable, number>;
      totalDeleted: number;
      /** True when the time budget stopped the run before every table was drained. */
      truncated: boolean;
      durationMs: number;
    };

/**
 * Deletes expired rows in bounded batches. Only the replica holding the
 * advisory lock prunes; others return `{ skipped: true }` immediately.
 */
export async function pruneExpiredRows(pool: Pool, options: PruneOptions = {}): Promise<PruneResult> {
  const graceMs = options.graceMs ?? DEFAULT_PRUNE_GRACE_MS;
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_PRUNE_TIME_BUDGET_MS;
  const cutoff = new Date((options.now ?? new Date()).getTime() - graceMs);
  const started = Date.now();

  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [PRUNE_LOCK_NAME],
    );
    if (locked.rows[0]?.locked !== true) return { skipped: true };
    try {
      const deleted = Object.fromEntries(PRUNE_TABLES.map((table) => [table, 0])) as Record<PruneTable, number>;
      let truncated = false;
      outer: for (const table of PRUNE_TABLES) {
        for (;;) {
          if (Date.now() - started >= timeBudgetMs) {
            truncated = true;
            break outer;
          }
          // SKIP LOCKED: never wait on a row an in-flight command holds.
          const result = await client.query(
            `DELETE FROM ${table}
              WHERE ctid IN (SELECT ctid FROM ${table}
                              WHERE ${PRUNE_CONDITIONS[table]}
                              LIMIT $2
                              FOR UPDATE SKIP LOCKED)`,
            [cutoff, batchSize],
          );
          const count = result.rowCount ?? 0;
          deleted[table] += count;
          if (count < batchSize) break;
        }
      }
      const totalDeleted = Object.values(deleted).reduce((sum, count) => sum + count, 0);
      return { skipped: false, deleted, totalDeleted, truncated, durationMs: Date.now() - started };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [PRUNE_LOCK_NAME])
        .catch((error: unknown) => {
          // Destroying the connection releases its session-level lock.
          releaseError = error instanceof Error ? error : new Error(String(error));
        });
    }
  } catch (error) {
    releaseError ??= error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export type PruneScheduler = { stop(): void };

/**
 * Runs `run` every `intervalMs` (first run after `initialDelayMs`), never
 * overlapping itself. Failures are logged and the schedule continues.
 * Timers are unref()ed so they never keep the process alive.
 */
export function startPruneScheduler(input: {
  intervalMs: number;
  initialDelayMs?: number;
  logger: Pick<Logger, "info" | "debug" | "error">;
  run: () => Promise<PruneResult>;
}): PruneScheduler {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = async () => {
    try {
      const result = await input.run();
      if (result.skipped) {
        input.logger.debug({ event: "prune_skipped" }, "expired-row prune skipped: another process holds the lock");
      } else {
        input.logger.info(
          {
            event: "prune_completed",
            deleted: result.deleted,
            totalDeleted: result.totalDeleted,
            truncated: result.truncated,
            durationMs: result.durationMs,
          },
          "expired rows pruned",
        );
      }
    } catch (error) {
      input.logger.error({ err: error, event: "prune_failed" }, "expired-row prune failed");
    } finally {
      schedule(input.intervalMs);
    }
  };

  schedule(input.initialDelayMs ?? Math.min(input.intervalMs, 60_000));
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
