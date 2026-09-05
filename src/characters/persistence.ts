import type { Pool } from "pg";

import type { DefinitionId, RuntimeStateV1, VersionId } from "../systems/runtime.js";

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
