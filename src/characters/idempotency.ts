import type { Pool } from "pg";

export type ExecutionId = string;

export type ClaimExecutionInput = {
  actorId: string;
  commandKind: string;
  idempotencyKey: string;
  inputHash: string;
  newExecutionId: () => ExecutionId;
  now: Date;
  leaseMs: number;
  replayTtlMs: number;
};

export type ClaimExecutionResult =
  | { status: "claimed"; executionId: ExecutionId }
  | { status: "replay"; executionId: ExecutionId; resultJson: unknown }
  | { status: "mismatch" }
  | { status: "in_progress" };

type ExecutionRow = {
  execution_id: string;
  status: "pending" | "completed";
  input_hash: string;
  result_json: unknown;
  lease_expires_at: Date;
};

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * Claims (or replays / rejects) an execution for one actor-scoped idempotency key.
 *
 * - Inserts a new pending row when the key is unused, returning a fresh execution ID.
 * - Returns a completed replay when the key/input hash already succeeded.
 * - Returns `mismatch` when the key was used with different input.
 * - Returns `in_progress` when another non-expired lease owns the pending execution.
 * - Atomically reclaims an expired pending lease while preserving the original execution ID.
 */
export async function claimExecution(pool: Pool, input: ClaimExecutionInput): Promise<ClaimExecutionResult> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const provisionalExpiresAt = new Date(input.now.getTime() + input.replayTtlMs);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newExecutionId = input.newExecutionId();
    await client.query("SAVEPOINT claim_insert");
    try {
      await client.query(
        `INSERT INTO character_command_executions
           (actor_id, command_kind, idempotency_key, input_hash, execution_id, status, lease_expires_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [
          input.actorId,
          input.commandKind,
          input.idempotencyKey,
          input.inputHash,
          newExecutionId,
          leaseExpiresAt,
          provisionalExpiresAt,
        ],
      );
      await client.query("COMMIT");
      return { status: "claimed", executionId: newExecutionId };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT claim_insert");
    }

    const existing = await client.query<ExecutionRow>(
      `SELECT execution_id, status, input_hash, result_json, lease_expires_at
         FROM character_command_executions
        WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [input.actorId, input.commandKind, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      await client.query("ROLLBACK");
      throw new Error("claimExecution: execution row vanished after unique violation");
    }
    if (row.input_hash !== input.inputHash) {
      await client.query("COMMIT");
      return { status: "mismatch" };
    }
    if (row.status === "completed") {
      await client.query("COMMIT");
      return { status: "replay", executionId: row.execution_id, resultJson: row.result_json };
    }
    if (new Date(row.lease_expires_at).getTime() > input.now.getTime()) {
      await client.query("COMMIT");
      return { status: "in_progress" };
    }
    await client.query(
      `UPDATE character_command_executions
          SET lease_expires_at = $1, expires_at = $2
        WHERE execution_id = $3`,
      [leaseExpiresAt, provisionalExpiresAt, row.execution_id],
    );
    await client.query("COMMIT");
    return { status: "claimed", executionId: row.execution_id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
