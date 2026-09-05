import type { Pool } from "pg";

import type { DefinitionId, NormalizedRoll, RuntimeStateV1, VersionId } from "../systems/runtime.js";

export type CharacterId = string;
export type UserId = string;
export type ExecutionId = string;

export type CharacterLifecycle = "active" | "archived";

export type CharacterRecord = {
  characterId: CharacterId;
  ownerId: UserId;
  systemVersionId: VersionId;
  entityDefinitionId: DefinitionId;
  name: string;
  revision: number;
  state: RuntimeStateV1;
  visibility: "owner_only";
  lifecycle: CharacterLifecycle;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CharacterExecutionRecord = {
  executionId: ExecutionId;
  actorId: UserId;
  commandKind: string;
  idempotencyKey: string;
  inputHash: string;
  characterId: CharacterId | null;
  status: "pending" | "completed";
  resultJson: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type CreateCharacterInput = {
  character: {
    characterId: CharacterId;
    ownerId: UserId;
    systemVersionId: VersionId;
    entityDefinitionId: DefinitionId;
    name: string;
    state: RuntimeStateV1;
  };
  execution: {
    executionId: ExecutionId;
    actorId: UserId;
    commandKind: string;
    idempotencyKey: string;
    inputHash: string;
    resultJson: unknown;
    expiresAt: Date;
  };
  activity: {
    kind: string;
    payloadJson: unknown;
    requestId: string;
  };
  audit: {
    actorId: UserId;
    kind: string;
    summary: string;
    requestId: string;
  };
};

export type CharacterPageCursor = {
  updatedAt: Date;
  characterId: CharacterId;
};

export type ApplyCommandInput = {
  executionId: ExecutionId;
  characterId: CharacterId;
  actorId: UserId;
  expectedRevision: number;
  nextState: RuntimeStateV1;
  stateChanged: boolean;
  roll: NormalizedRoll | null;
  activity: {
    kind: string;
    payloadJson: unknown;
    requestId: string;
  };
  resultExpiresAt: Date;
  buildResult: (args: { record: CharacterRecord }) => unknown;
};

export type ApplyCommandOutcome =
  | { kind: "applied"; record: CharacterRecord; resultJson: unknown }
  | { kind: "already_completed"; resultJson: unknown }
  | { kind: "not_found" }
  | { kind: "archived" }
  | { kind: "conflict"; latestRevision: number };

export type ManagementMutation =
  | { kind: "rename"; name: string }
  | { kind: "transferOwnership"; toUserId: UserId }
  | { kind: "archive" }
  | { kind: "recover" };

export type ApplyManagementCommandInput = {
  executionId: ExecutionId;
  characterId: CharacterId;
  actorId: UserId;
  expectedRevision: number;
  mutation: ManagementMutation;
  activity: {
    kind: string;
    payloadJson: unknown;
    requestId: string;
  };
  audit: {
    kind: string;
    summary: string;
    requestId: string;
  };
  resultExpiresAt: Date;
  buildResult: (args: { record: CharacterRecord }) => unknown;
};

export type ApplyManagementCommandOutcome =
  | { kind: "applied"; record: CharacterRecord; resultJson: unknown }
  | { kind: "already_completed"; resultJson: unknown }
  | { kind: "not_found" }
  | { kind: "invalid_target" }
  | { kind: "conflict"; latestRevision: number };

export type CharacterActivityRow = {
  id: string;
  characterRevision: number;
  kind: string;
  payloadJson: unknown;
  rollId: string | null;
  requestId: string;
  occurredAt: Date;
  cursorText: string;
};

/**
 * Keyset-pagination anchor for activity. `occurredAtText` carries the precise
 * `occurred_at` value from Postgres (microsecond precision) as text instead of
 * a `Date`, because a JS `Date` only holds milliseconds and would break the
 * `(occurred_at, id) < cursor` comparison for rows sharing the same millisecond.
 */
export type CharacterActivityCursor = { occurredAtText: string; id: string };

export interface CharacterPersistenceRepository {
  loadExecution(input: {
    actorId: UserId;
    commandKind: string;
    idempotencyKey: string;
  }): Promise<CharacterExecutionRecord | null>;

  createCharacterTx(input: CreateCharacterInput): Promise<CharacterRecord>;

  openOwnedCharacter(characterId: CharacterId, ownerId: UserId): Promise<CharacterRecord | null>;

  listOwnedCharactersPage(
    ownerId: UserId,
    page: { limit: number; cursor: CharacterPageCursor | null },
  ): Promise<CharacterRecord[]>;

  applyCommandTx(input: ApplyCommandInput): Promise<ApplyCommandOutcome>;

  applyManagementCommandTx(input: ApplyManagementCommandInput): Promise<ApplyManagementCommandOutcome>;

  finalizeExecutionError(input: { executionId: ExecutionId; resultJson: unknown; expiresAt: Date }): Promise<void>;

  changedDefinitionIdsSinceRevision(
    characterId: CharacterId,
    sinceRevision: number,
  ): Promise<{ changedDefinitionIds: DefinitionId[]; latestActivity: { id: string; occurredAtText: string } | null }>;

  listActivityPage(
    characterId: CharacterId,
    page: { limit: number; cursor: CharacterActivityCursor | null },
  ): Promise<CharacterActivityRow[]>;

  recordAudit(input: { characterId: CharacterId; actorId: UserId; kind: string; summary: string; requestId: string }): Promise<void>;
}

type CharacterRow = {
  id: string;
  owner_id: string;
  system_version_id: string;
  entity_definition_id: string;
  name: string;
  revision: number;
  state_json: unknown;
  visibility: string;
  lifecycle: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ExecutionRow = {
  execution_id: string;
  actor_id: string;
  command_kind: string;
  idempotency_key: string;
  input_hash: string;
  character_id: string | null;
  status: string;
  result_json: unknown;
  created_at: Date;
  expires_at: Date;
};

export function createCharacterPersistenceRepository(pool: Pool): CharacterPersistenceRepository {
  return {
    async loadExecution(input) {
      const result = await pool.query<ExecutionRow>(
        `SELECT execution_id, actor_id, command_kind, idempotency_key, input_hash, character_id,
                status, result_json, created_at, expires_at
           FROM character_command_executions
          WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3 AND expires_at > now()`,
        [input.actorId, input.commandKind, input.idempotencyKey],
      );
      const row = result.rows[0];
      return row === undefined ? null : toExecutionRecord(row);
    },

    async createCharacterTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<CharacterRow>(
          `INSERT INTO characters (id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle)
           VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, 'owner_only', 'active')
           RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
          [
            input.character.characterId,
            input.character.ownerId,
            input.character.systemVersionId,
            input.character.entityDefinitionId,
            input.character.name,
            JSON.stringify(input.character.state),
          ],
        );
        const characterRow = requireRow(inserted.rows[0], "createCharacterTx");
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [characterRow.id, characterRow.revision, input.activity.kind, JSON.stringify(input.activity.payloadJson), input.activity.requestId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [characterRow.id, input.audit.actorId, input.audit.kind, input.audit.summary, input.audit.requestId],
        );
        await client.query(
          `INSERT INTO character_command_executions
             (actor_id, command_kind, idempotency_key, input_hash, character_id, execution_id, status, lease_expires_at, result_json, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completed', now(), $7::jsonb, $8)`,
          [
            input.execution.actorId,
            input.execution.commandKind,
            input.execution.idempotencyKey,
            input.execution.inputHash,
            characterRow.id,
            input.execution.executionId,
            JSON.stringify(input.execution.resultJson),
            input.execution.expiresAt,
          ],
        );
        await client.query("COMMIT");
        return toCharacterRecord(characterRow);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async openOwnedCharacter(characterId, ownerId) {
      const result = await pool.query<CharacterRow>(
        `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
           FROM characters
          WHERE id = $1 AND owner_id = $2`,
        [characterId, ownerId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCharacterRecord(row);
    },

    async listOwnedCharactersPage(ownerId, page) {
      const rows =
        page.cursor === null
          ? await pool.query<CharacterRow>(
              `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
                 FROM characters
                WHERE owner_id = $1
                ORDER BY updated_at DESC, id DESC
                LIMIT $2`,
              [ownerId, page.limit],
            )
          : await pool.query<CharacterRow>(
              `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
                 FROM characters
                WHERE owner_id = $1 AND (updated_at, id) < ($2, $3)
                ORDER BY updated_at DESC, id DESC
                LIMIT $4`,
              [ownerId, page.cursor.updatedAt, page.cursor.characterId, page.limit],
            );
      return rows.rows.map(toCharacterRecord);
    },

    async applyCommandTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const execResult = await client.query<{ status: string; result_json: unknown }>(
          `SELECT status, result_json FROM character_command_executions WHERE execution_id = $1 FOR UPDATE`,
          [input.executionId],
        );
        const execRow = execResult.rows[0];
        if (execRow === undefined) throw new Error("applyCommandTx: execution row missing");
        if (execRow.status === "completed") {
          await client.query("COMMIT");
          return { kind: "already_completed", resultJson: execRow.result_json };
        }

        const charResult = await client.query<CharacterRow>(
          `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
             FROM characters WHERE id = $1 FOR UPDATE`,
          [input.characterId],
        );
        const charRow = charResult.rows[0];
        if (charRow === undefined || charRow.owner_id !== input.actorId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        if (charRow.lifecycle === "archived") {
          await client.query("ROLLBACK");
          return { kind: "archived" };
        }
        if (charRow.revision !== input.expectedRevision) {
          const latestRevision = charRow.revision;
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }

        let updatedRow = charRow;
        if (input.stateChanged) {
          const updated = await client.query<CharacterRow>(
            `UPDATE characters
                SET state_json = $1::jsonb, revision = revision + 1, updated_at = now()
              WHERE id = $2
              RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
            [JSON.stringify(input.nextState), input.characterId],
          );
          updatedRow = requireRow(updated.rows[0], "applyCommandTx.update");
        }

        let rollId: string | null = null;
        if (input.roll !== null) {
          const insertedRoll = await client.query<{ id: string }>(
            `INSERT INTO character_rolls
               (character_id, actor_id, action_id, execution_id, expression, dice_json, bindings_json, total, rendered_output, audience, request_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 'owner_only', $10)
             RETURNING id`,
            [
              updatedRow.id,
              input.actorId,
              input.roll.actionId,
              input.executionId,
              input.roll.expression,
              JSON.stringify(input.roll.dice),
              JSON.stringify(input.roll.bindings),
              input.roll.total,
              input.roll.output,
              input.activity.requestId,
            ],
          );
          rollId = requireRow(insertedRoll.rows[0], "applyCommandTx.roll").id;
        }

        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, roll_id, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            updatedRow.id,
            updatedRow.revision,
            input.activity.kind,
            JSON.stringify(input.activity.payloadJson),
            rollId,
            input.activity.requestId,
          ],
        );

        const record = toCharacterRecord(updatedRow);
        const resultJson = input.buildResult({ record });
        await client.query(
          `UPDATE character_command_executions
              SET status = 'completed', result_json = $1::jsonb, expires_at = $2
            WHERE execution_id = $3`,
          [JSON.stringify(resultJson), input.resultExpiresAt, input.executionId],
        );
        await client.query("COMMIT");
        return { kind: "applied", record, resultJson };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async applyManagementCommandTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const execResult = await client.query<{ status: string; result_json: unknown }>(
          `SELECT status, result_json FROM character_command_executions WHERE execution_id = $1 FOR UPDATE`,
          [input.executionId],
        );
        const execRow = execResult.rows[0];
        if (execRow === undefined) throw new Error("applyManagementCommandTx: execution row missing");
        if (execRow.status === "completed") {
          await client.query("COMMIT");
          return { kind: "already_completed", resultJson: execRow.result_json };
        }

        const charResult = await client.query<CharacterRow>(
          `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
             FROM characters WHERE id = $1 FOR UPDATE`,
          [input.characterId],
        );
        const charRow = charResult.rows[0];
        if (charRow === undefined || charRow.owner_id !== input.actorId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        if (charRow.revision !== input.expectedRevision) {
          const latestRevision = charRow.revision;
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }

        if (input.mutation.kind === "transferOwnership") {
          const destination = await client.query(`SELECT 1 FROM users WHERE id = $1`, [input.mutation.toUserId]);
          if (destination.rows[0] === undefined) {
            await client.query("ROLLBACK");
            return { kind: "invalid_target" };
          }
        }

        let updated: { rows: CharacterRow[] };
        switch (input.mutation.kind) {
          case "rename":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET name = $1, revision = revision + 1, updated_at = now()
                WHERE id = $2
              RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.mutation.name, input.characterId],
            );
            break;
          case "transferOwnership":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET owner_id = $1, revision = revision + 1, updated_at = now()
                WHERE id = $2
              RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.mutation.toUserId, input.characterId],
            );
            break;
          case "archive":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET lifecycle = 'archived', archived_at = now(), revision = revision + 1, updated_at = now()
                WHERE id = $1
              RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.characterId],
            );
            break;
          case "recover":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET lifecycle = 'active', archived_at = null, revision = revision + 1, updated_at = now()
                WHERE id = $1
              RETURNING id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.characterId],
            );
            break;
        }
        const updatedRow = requireRow(updated.rows[0], "applyManagementCommandTx.update");

        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [updatedRow.id, updatedRow.revision, input.activity.kind, JSON.stringify(input.activity.payloadJson), input.activity.requestId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [updatedRow.id, input.actorId, input.audit.kind, input.audit.summary, input.audit.requestId],
        );

        const record = toCharacterRecord(updatedRow);
        const resultJson = input.buildResult({ record });
        await client.query(
          `UPDATE character_command_executions
              SET status = 'completed', result_json = $1::jsonb, expires_at = $2
            WHERE execution_id = $3`,
          [JSON.stringify(resultJson), input.resultExpiresAt, input.executionId],
        );
        await client.query("COMMIT");
        return { kind: "applied", record, resultJson };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listActivityPage(characterId, page) {
      const rowShape = `id, character_revision, kind, payload_json, roll_id, request_id,
             occurred_at, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_cursor`;
      const rows =
        page.cursor === null
          ? await pool.query<{
              id: string;
              character_revision: number;
              kind: string;
              payload_json: unknown;
              roll_id: string | null;
              request_id: string;
              occurred_at: Date;
              occurred_at_cursor: string;
            }>(
              `SELECT ${rowShape}
                 FROM character_activity_events
                WHERE character_id = $1
                ORDER BY occurred_at DESC, id DESC
                LIMIT $2`,
              [characterId, page.limit],
            )
          : await pool.query<{
              id: string;
              character_revision: number;
              kind: string;
              payload_json: unknown;
              roll_id: string | null;
              request_id: string;
              occurred_at: Date;
              occurred_at_cursor: string;
            }>(
              `SELECT ${rowShape}
                 FROM character_activity_events
                WHERE character_id = $1 AND (occurred_at, id) < ($2::timestamptz, $3)
                ORDER BY occurred_at DESC, id DESC
                LIMIT $4`,
              [characterId, page.cursor.occurredAtText, page.cursor.id, page.limit],
            );
      return rows.rows.map((row) => ({
        id: row.id,
        characterRevision: row.character_revision,
        kind: row.kind,
        payloadJson: row.payload_json,
        rollId: row.roll_id,
        requestId: row.request_id,
        occurredAt: row.occurred_at,
        cursorText: row.occurred_at_cursor,
      }));
    },

    async recordAudit(input) {
      await pool.query(
        `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.characterId, input.actorId, input.kind, input.summary, input.requestId],
      );
    },

    async finalizeExecutionError(input) {
      await pool.query(
        `UPDATE character_command_executions
            SET status = 'completed', result_json = $1::jsonb, expires_at = $2
          WHERE execution_id = $3 AND status = 'pending'`,
        [JSON.stringify(input.resultJson), input.expiresAt, input.executionId],
      );
    },

    async changedDefinitionIdsSinceRevision(characterId, sinceRevision) {
      const result = await pool.query<{ id: string; payload_json: unknown; occurred_at_cursor: string }>(
        `SELECT id, payload_json, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_cursor
          FROM character_activity_events
          WHERE character_id = $1 AND character_revision > $2
          ORDER BY character_revision ASC`,
        [characterId, sinceRevision],
      );
      const ids = new Set<DefinitionId>();
      for (const row of result.rows) {
        const payload = row.payload_json as { changedDefinitionIds?: unknown };
        if (Array.isArray(payload?.changedDefinitionIds)) {
          for (const id of payload.changedDefinitionIds) {
            if (typeof id === "string") ids.add(id);
          }
        }
      }
      const lastRow = result.rows[result.rows.length - 1];
      const latestActivity =
        lastRow === undefined ? null : { id: lastRow.id, occurredAtText: lastRow.occurred_at_cursor };
      return { changedDefinitionIds: [...ids], latestActivity };
    },
  };
}

function toCharacterRecord(row: CharacterRow): CharacterRecord {
  return {
    characterId: row.id,
    ownerId: row.owner_id,
    systemVersionId: row.system_version_id,
    entityDefinitionId: row.entity_definition_id,
    name: row.name,
    revision: row.revision,
    state: row.state_json as RuntimeStateV1,
    visibility: "owner_only",
    lifecycle: row.lifecycle as CharacterLifecycle,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExecutionRecord(row: ExecutionRow): CharacterExecutionRecord {
  return {
    executionId: row.execution_id,
    actorId: row.actor_id,
    commandKind: row.command_kind,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    characterId: row.character_id,
    status: row.status as "pending" | "completed",
    resultJson: row.result_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function requireRow<T>(row: T | undefined, where: string): T {
  if (row === undefined) throw new Error(`${where} returned no row`);
  return row;
}
