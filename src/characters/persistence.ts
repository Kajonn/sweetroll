import type { Pool } from "pg";

import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { DefinitionId, NormalizedRoll, RuntimeStateV1, VersionId } from "../systems/runtime.js";

export type CharacterId = string;
export type UserId = string;
export type ExecutionId = string;

export type CharacterLifecycle = "active" | "archived";

export type CharacterRecord = {
  characterId: CharacterId;
  /** Standalone owner; NULL while the character is attached to a campaign. */
  ownerId: UserId | null;
  /** Campaign custody; NULL for standalone characters (ownership union). */
  campaignId: string | null;
  placementGeneration: number;
  /** Immutable adopter recorded at adoption; NULL for standalone and campaign-created sheets. */
  returnOwnerId: UserId | null;
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
    createdAt: Date;
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

export type DuplicateCharacterInput = {
  executionId: ExecutionId;
  duplicate: {
    characterId: CharacterId;
    ownerId: UserId;
    systemVersionId: VersionId;
    entityDefinitionId: DefinitionId;
    name: string;
    state: RuntimeStateV1;
    createdAt: Date;
  };
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

export type DuplicateCharacterOutcome =
  | { kind: "applied"; record: CharacterRecord; resultJson: unknown }
  | { kind: "already_completed"; resultJson: unknown };

export type MigrationPreviewRecord = {
  previewId: string;
  characterId: CharacterId;
  ownerId: UserId;
  sourceRevision: number;
  sourceVersionId: VersionId;
  sourceChecksum: string;
  targetVersionId: VersionId;
  targetChecksum: string;
  mappingJson: unknown;
  candidateState: RuntimeStateV1;
  candidateProjection: unknown;
  warnings: string[];
  previewChecksum: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type InsertMigrationPreviewInput = {
  previewId: string;
  characterId: CharacterId;
  ownerId: UserId;
  sourceRevision: number;
  sourceVersionId: VersionId;
  sourceChecksum: string;
  targetVersionId: VersionId;
  targetChecksum: string;
  mappingJson: unknown;
  candidateState: RuntimeStateV1;
  candidateProjection: unknown;
  warnings: string[];
  previewChecksum: string;
  expiresAt: Date;
  audit: { actorId: UserId; kind: string; summary: string; requestId: string };
};

export type CommitMigrationInput = {
  executionId: ExecutionId;
  characterId: CharacterId;
  actorId: UserId;
  expectedRevision: number;
  previewId: string;
  sourceRevision: number;
  sourceVersionId: VersionId;
  sourceChecksum: string;
  targetVersionId: VersionId;
  targetChecksum: string;
  previewChecksum: string;
  candidateState: RuntimeStateV1;
  beforeState: RuntimeStateV1;
  rollbackDeadline: Date;
  now: Date;
  activity: { kind: string; payloadJson: unknown; requestId: string };
  audit: { actorId: UserId; kind: string; summary: string; requestId: string };
  resultExpiresAt: Date;
  buildResult: (args: { record: CharacterRecord }) => unknown;
};

export type CommitMigrationOutcome =
  | { kind: "applied"; record: CharacterRecord; resultJson: unknown }
  | { kind: "already_completed"; resultJson: unknown }
  | { kind: "not_found" }
  | { kind: "consumed"; latestRevision: number }
  | { kind: "expired"; latestRevision: number }
  | { kind: "conflict"; latestRevision: number };

export type MigrationRecord = {
  migrationId: string;
  characterId: CharacterId;
  previewId: string;
  sourceVersionId: VersionId;
  targetVersionId: VersionId;
  beforeState: RuntimeStateV1;
  afterState: RuntimeStateV1;
  commitRevision: number;
  rollbackDeadline: Date;
  rolledBackAt: Date | null;
  rollbackRevision: number | null;
};

export type LoadMigrationInput = { migrationId: string; characterId: CharacterId; actorId: UserId };

export type RollbackMigrationInput = {
  executionId: ExecutionId;
  characterId: CharacterId;
  actorId: UserId;
  migration: MigrationRecord;
  sourceVersionId: VersionId;
  sourceState: RuntimeStateV1;
  now: Date;
  activity: { kind: string; payloadJson: unknown; requestId: string };
  audit: { actorId: UserId; kind: string; summary: string; requestId: string };
  resultExpiresAt: Date;
  buildResult: (args: { record: CharacterRecord }) => unknown;
};

export type RollbackMigrationOutcome =
  | { kind: "applied"; record: CharacterRecord; resultJson: unknown }
  | { kind: "already_completed"; resultJson: unknown }
  | { kind: "not_found" }
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

  /**
   * Ownership-union scope for one character in any placement: NULL when the
   * row does not exist. Attached rows (campaignId non-null) must never
   * authorize owner-only paths; standalone receipts must never replay them.
   */
  loadCharacterScope(characterId: CharacterId): Promise<{
    characterId: CharacterId;
    ownerId: UserId | null;
    campaignId: string | null;
    placementGeneration: number;
    returnOwnerId: UserId | null;
    revision: number;
    lifecycle: CharacterLifecycle;
    systemVersionId: VersionId;
  } | null>;

  listOwnedCharactersPage(
    ownerId: UserId,
    page: { limit: number; cursor: CharacterPageCursor | null },
  ): Promise<CharacterRecord[]>;

  applyCommandTx(input: ApplyCommandInput): Promise<ApplyCommandOutcome>;

  applyManagementCommandTx(input: ApplyManagementCommandInput): Promise<ApplyManagementCommandOutcome>;

  duplicateCharacterTx(input: DuplicateCharacterInput): Promise<DuplicateCharacterOutcome>;

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

  loadVersionIdentity(versionId: VersionId): Promise<{ systemId: string; checksum: string } | null>;

  insertMigrationPreview(input: InsertMigrationPreviewInput): Promise<MigrationPreviewRecord>;

  loadMigrationPreview(previewId: string): Promise<MigrationPreviewRecord | null>;

  commitMigrationTx(input: CommitMigrationInput): Promise<CommitMigrationOutcome>;

  loadMigration(input: LoadMigrationInput): Promise<MigrationRecord | null>;

  rollbackMigrationTx(input: RollbackMigrationInput): Promise<RollbackMigrationOutcome>;
}

type CharacterRow = {
  id: string;
  owner_id: string | null;
  campaign_id: string | null;
  placement_generation: number;
  return_owner_id: string | null;
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

type MigrationPreviewRow = {
  id: string;
  character_id: string;
  owner_id: string;
  source_revision: number;
  source_version_id: string;
  source_checksum: string;
  target_version_id: string;
  target_checksum: string;
  mapping_json: unknown;
  candidate_state_json: unknown;
  candidate_projection_json: unknown;
  warnings_json: string[];
  preview_checksum: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

export function createCharacterPersistenceRepository(pool: Pool): CharacterPersistenceRepository {
  return {
    async loadExecution(input) {
      const result = await pool.query<ExecutionRow>(
        `SELECT execution_id, actor_id, command_kind, idempotency_key, input_hash, character_id,
                status, result_json, created_at, expires_at
           FROM character_command_executions
          WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
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
          `INSERT INTO characters (id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, 'owner_only', 'active', $7, $7)
           RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
          [
            input.character.characterId,
            input.character.ownerId,
            input.character.systemVersionId,
            input.character.entityDefinitionId,
            input.character.name,
            JSON.stringify(input.character.state),
            input.character.createdAt,
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

    async duplicateCharacterTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const execResult = await client.query<{ status: string; result_json: unknown }>(
          `SELECT status, result_json FROM character_command_executions WHERE execution_id = $1 FOR UPDATE`,
          [input.executionId],
        );
        const execRow = execResult.rows[0];
        if (execRow === undefined) throw new Error("duplicateCharacterTx: execution row missing");
        if (execRow.status === "completed") {
          await client.query("COMMIT");
          return { kind: "already_completed", resultJson: execRow.result_json };
        }

        const inserted = await client.query<CharacterRow>(
          `INSERT INTO characters (id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, 'owner_only', 'active', $7, $7)
           RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
          [
            input.duplicate.characterId,
            input.duplicate.ownerId,
            input.duplicate.systemVersionId,
            input.duplicate.entityDefinitionId,
            input.duplicate.name,
            JSON.stringify(input.duplicate.state),
            input.duplicate.createdAt,
          ],
        );
        const characterRow = requireRow(inserted.rows[0], "duplicateCharacterTx");
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [characterRow.id, characterRow.revision, input.activity.kind, JSON.stringify(input.activity.payloadJson), input.activity.requestId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [characterRow.id, input.duplicate.ownerId, input.audit.kind, input.audit.summary, input.audit.requestId],
        );

        const record = toCharacterRecord(characterRow);
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

    async openOwnedCharacter(characterId, ownerId) {
      const result = await pool.query<CharacterRow>(
        `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
           FROM characters
          WHERE id = $1 AND owner_id = $2 AND campaign_id IS NULL`,
        [characterId, ownerId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCharacterRecord(row);
    },

    async loadCharacterScope(characterId) {
      const result = await pool.query<CharacterRow>(
        `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
           FROM characters
          WHERE id = $1`,
        [characterId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (row.lifecycle !== "active" && row.lifecycle !== "archived") {
        throw new Error(`Unknown character lifecycle: ${row.lifecycle}`);
      }
      return {
        characterId: row.id,
        ownerId: row.owner_id,
        campaignId: row.campaign_id,
        placementGeneration: row.placement_generation,
        returnOwnerId: row.return_owner_id,
        revision: row.revision,
        lifecycle: row.lifecycle,
        systemVersionId: row.system_version_id,
      };
    },

    async listOwnedCharactersPage(ownerId, page) {
      const rows =
        page.cursor === null
          ? await pool.query<CharacterRow>(
              `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
                 FROM characters
                WHERE owner_id = $1 AND campaign_id IS NULL
                ORDER BY updated_at DESC, id DESC
                LIMIT $2`,
              [ownerId, page.limit],
            )
          : await pool.query<CharacterRow>(
              `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
                 FROM characters
                WHERE owner_id = $1 AND campaign_id IS NULL AND (updated_at, id) < ($2, $3)
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
          `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
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
              RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
            [JSON.stringify(input.nextState), input.characterId],
          );
          updatedRow = requireRow(updated.rows[0], "applyCommandTx.update");
        }

        let rollId: string | null = null;
        if (input.roll !== null) {
          const insertedRoll = await client.query<{ id: string }>(
            `INSERT INTO character_rolls
               (character_id, actor_id, action_id, execution_id, expression, dice_json, bindings_json, total, rendered_output, audience, request_id)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
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
              input.roll.audience,
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
          `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
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
              RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.mutation.name, input.characterId],
            );
            break;
          case "transferOwnership":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET owner_id = $1, revision = revision + 1, updated_at = now()
                WHERE id = $2
              RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.mutation.toUserId, input.characterId],
            );
            break;
          case "archive":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET lifecycle = 'archived', archived_at = now(), revision = revision + 1, updated_at = now()
                WHERE id = $1
              RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
              [input.characterId],
            );
            break;
          case "recover":
            updated = await client.query<CharacterRow>(
              `UPDATE characters SET lifecycle = 'active', archived_at = null, revision = revision + 1, updated_at = now()
                WHERE id = $1
              RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
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

    async loadVersionIdentity(versionId) {
      const result = await pool.query<{ system_id: string; checksum: string }>(
        `SELECT system_id, checksum FROM system_versions WHERE id = $1`,
        [versionId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { systemId: row.system_id, checksum: row.checksum };
    },

    async insertMigrationPreview(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<MigrationPreviewRow>(
          `INSERT INTO character_migration_previews
             (id, character_id, owner_id, source_revision, source_version_id, source_checksum,
              target_version_id, target_checksum, mapping_json, candidate_state_json,
              candidate_projection_json, warnings_json, preview_checksum, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
           RETURNING id, character_id, owner_id, source_revision, source_version_id, source_checksum,
                     target_version_id, target_checksum, mapping_json, candidate_state_json,
                     candidate_projection_json, warnings_json, preview_checksum, created_at, expires_at, consumed_at`,
          [
            input.previewId,
            input.characterId,
            input.ownerId,
            input.sourceRevision,
            input.sourceVersionId,
            input.sourceChecksum,
            input.targetVersionId,
            input.targetChecksum,
            JSON.stringify(input.mappingJson),
            JSON.stringify(input.candidateState),
            JSON.stringify(input.candidateProjection),
            JSON.stringify(input.warnings),
            input.previewChecksum,
            input.expiresAt,
          ],
        );
        const record = toMigrationPreviewRecord(requireRow(result.rows[0], "insertMigrationPreview"));
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.characterId, input.audit.actorId, input.audit.kind, input.audit.summary, input.audit.requestId],
        );
        await client.query("COMMIT");
        return record;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async loadMigrationPreview(previewId) {
      const result = await pool.query<MigrationPreviewRow>(
        `SELECT id, character_id, owner_id, source_revision, source_version_id, source_checksum,
                target_version_id, target_checksum, mapping_json, candidate_state_json,
                candidate_projection_json, warnings_json, preview_checksum, created_at, expires_at, consumed_at
           FROM character_migration_previews WHERE id = $1`,
        [previewId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toMigrationPreviewRecord(row);
    },

    async commitMigrationTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const execResult = await client.query<{ status: string; result_json: unknown }>(
          `SELECT status, result_json FROM character_command_executions WHERE execution_id = $1 FOR UPDATE`,
          [input.executionId],
        );
        const execRow = execResult.rows[0];
        if (execRow === undefined) throw new Error("commitMigrationTx: execution row missing");
        if (execRow.status === "completed") {
          await client.query("COMMIT");
          return { kind: "already_completed", resultJson: execRow.result_json };
        }

        const previewResult = await client.query<MigrationPreviewRow>(
          `SELECT id, character_id, owner_id, source_revision, source_version_id, source_checksum,
                  target_version_id, target_checksum, mapping_json, candidate_state_json,
                  candidate_projection_json, warnings_json, preview_checksum, created_at, expires_at, consumed_at
             FROM character_migration_previews WHERE id = $1 FOR UPDATE`,
          [input.previewId],
        );
        const previewRow = previewResult.rows[0];
        if (previewRow === undefined || previewRow.character_id !== input.characterId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        if (previewRow.owner_id !== input.actorId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }

        const charResult = await client.query<CharacterRow>(
          `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
             FROM characters WHERE id = $1 FOR UPDATE`,
          [input.characterId],
        );
        const charRow = charResult.rows[0];
        if (charRow === undefined || charRow.owner_id !== input.actorId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        const latestRevision = charRow.revision;

        if (previewRow.consumed_at !== null) {
          await client.query("ROLLBACK");
          return { kind: "consumed", latestRevision };
        }
        if (new Date(previewRow.expires_at).getTime() <= input.now.getTime()) {
          await client.query("ROLLBACK");
          return { kind: "expired", latestRevision };
        }

        // Recompute the preview checksum over the stored bound fields exactly as
        // the preview did. Any tampering of the materialized bindings (candidate
        // state/projection, mappings/defaults, version identities, owner, expiry)
        // fails the atomic pre-condition instead of committing a mutated candidate.
        const storedMappings = previewRow.mapping_json as {
          mappings: Record<DefinitionId, DefinitionId>;
          defaults: Record<DefinitionId, unknown>;
        };
        const recomputedChecksum = hashInput({
          characterId: previewRow.character_id,
          sourceRevision: previewRow.source_revision,
          sourceVersionId: previewRow.source_version_id,
          sourceChecksum: previewRow.source_checksum,
          targetVersionId: previewRow.target_version_id,
          targetChecksum: previewRow.target_checksum,
          mappings: storedMappings.mappings,
          defaults: storedMappings.defaults,
          candidateState: previewRow.candidate_state_json,
          candidateProjection: previewRow.candidate_projection_json,
          warnings: previewRow.warnings_json,
          owner: previewRow.owner_id,
          expiresAt: new Date(previewRow.expires_at).toISOString(),
        });
        if (recomputedChecksum !== previewRow.preview_checksum) {
          await client.query("ROLLBACK");
          return { kind: "consumed", latestRevision };
        }

        if (
          charRow.revision !== input.expectedRevision
          || charRow.revision !== input.sourceRevision
          || charRow.system_version_id !== previewRow.source_version_id
        ) {
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }

        const updated = await client.query<CharacterRow>(
          `UPDATE characters
              SET system_version_id = $1::uuid, state_json = $2::jsonb, revision = revision + 1, updated_at = now()
            WHERE id = $3
            RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
          [input.targetVersionId, JSON.stringify(input.candidateState), input.characterId],
        );
        const updatedRow = requireRow(updated.rows[0], "commitMigrationTx.update");

        await client.query(
          `UPDATE character_migration_previews SET consumed_at = now() WHERE id = $1`,
          [input.previewId],
        );
        await client.query(
          `INSERT INTO character_migrations
             (id, character_id, preview_id, source_version_id, target_version_id, before_state_json,
              after_state_json, commit_revision, rollback_deadline, actor_id, request_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
          [
            input.executionId,
            input.characterId,
            input.previewId,
            input.sourceVersionId,
            input.targetVersionId,
            JSON.stringify(input.beforeState),
            JSON.stringify(input.candidateState),
            updatedRow.revision,
            input.rollbackDeadline,
            input.actorId,
            input.activity.requestId,
          ],
        );
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [updatedRow.id, updatedRow.revision, input.activity.kind, JSON.stringify(input.activity.payloadJson), input.activity.requestId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [updatedRow.id, input.audit.actorId, input.audit.kind, input.audit.summary, input.audit.requestId],
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

    async loadMigration(input) {
      const result = await pool.query<{
        id: string;
        character_id: string;
        preview_id: string;
        source_version_id: string;
        target_version_id: string;
        before_state_json: unknown;
        after_state_json: unknown;
        commit_revision: number;
        rollback_deadline: Date;
        rolled_back_at: Date | null;
        rollback_revision: number | null;
      }>(
        `SELECT id, character_id, preview_id, source_version_id, target_version_id, before_state_json,
                after_state_json, commit_revision, rollback_deadline, rolled_back_at, rollback_revision
           FROM character_migrations
          WHERE id = $1 AND character_id = $2 AND actor_id = $3`,
        [input.migrationId, input.characterId, input.actorId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        migrationId: row.id,
        characterId: row.character_id,
        previewId: row.preview_id,
        sourceVersionId: row.source_version_id,
        targetVersionId: row.target_version_id,
        beforeState: row.before_state_json as RuntimeStateV1,
        afterState: row.after_state_json as RuntimeStateV1,
        commitRevision: row.commit_revision,
        rollbackDeadline: row.rollback_deadline,
        rolledBackAt: row.rolled_back_at,
        rollbackRevision: row.rollback_revision,
      };
    },

    async rollbackMigrationTx(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const execResult = await client.query<{ status: string; result_json: unknown }>(
          `SELECT status, result_json FROM character_command_executions WHERE execution_id = $1 FOR UPDATE`,
          [input.executionId],
        );
        const execRow = execResult.rows[0];
        if (execRow === undefined) throw new Error("rollbackMigrationTx: execution row missing");
        if (execRow.status === "completed") {
          await client.query("COMMIT");
          return { kind: "already_completed", resultJson: execRow.result_json };
        }

        const migrationResult = await client.query<{
          character_id: string;
          source_version_id: string;
          before_state_json: unknown;
          commit_revision: number;
          rollback_deadline: Date;
          rolled_back_at: Date | null;
        }>(
          `SELECT character_id, source_version_id, before_state_json, commit_revision, rollback_deadline, rolled_back_at
             FROM character_migrations WHERE id = $1 FOR UPDATE`,
          [input.migration.migrationId],
        );
        const migrationRow = migrationResult.rows[0];
        if (migrationRow === undefined || migrationRow.character_id !== input.characterId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }

        const charResult = await client.query<CharacterRow>(
          `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at
             FROM characters WHERE id = $1 FOR UPDATE`,
          [input.characterId],
        );
        const charRow = charResult.rows[0];
        if (charRow === undefined || charRow.owner_id !== input.actorId) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        const latestRevision = charRow.revision;

        if (migrationRow.rolled_back_at !== null) {
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }
        if (new Date(migrationRow.rollback_deadline).getTime() <= input.now.getTime()) {
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }
        if (charRow.revision !== migrationRow.commit_revision) {
          await client.query("ROLLBACK");
          return { kind: "conflict", latestRevision };
        }

        const restoredState = migrationRow.before_state_json as RuntimeStateV1;
        const updated = await client.query<CharacterRow>(
          `UPDATE characters
              SET system_version_id = $1::uuid, state_json = $2::jsonb, revision = revision + 1, updated_at = now()
            WHERE id = $3
            RETURNING id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at`,
          [migrationRow.source_version_id, JSON.stringify(restoredState), input.characterId],
        );
        const updatedRow = requireRow(updated.rows[0], "rollbackMigrationTx.update");

        await client.query(
          `UPDATE character_migrations SET rollback_revision = $1, rolled_back_at = now() WHERE id = $2`,
          [updatedRow.revision, input.migration.migrationId],
        );
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [updatedRow.id, updatedRow.revision, input.activity.kind, JSON.stringify(input.activity.payloadJson), input.activity.requestId],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [updatedRow.id, input.audit.actorId, input.audit.kind, input.audit.summary, input.audit.requestId],
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
  };
}

function toCharacterRecord(row: CharacterRow): CharacterRecord {
  return {
    characterId: row.id,
    ownerId: row.owner_id,
    campaignId: row.campaign_id,
    placementGeneration: row.placement_generation,
    returnOwnerId: row.return_owner_id,
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

function toMigrationPreviewRecord(row: MigrationPreviewRow): MigrationPreviewRecord {
  return {
    previewId: row.id,
    characterId: row.character_id,
    ownerId: row.owner_id,
    sourceRevision: row.source_revision,
    sourceVersionId: row.source_version_id,
    sourceChecksum: row.source_checksum,
    targetVersionId: row.target_version_id,
    targetChecksum: row.target_checksum,
    mappingJson: row.mapping_json,
    candidateState: row.candidate_state_json as RuntimeStateV1,
    candidateProjection: row.candidate_projection_json,
    warnings: row.warnings_json,
    previewChecksum: row.preview_checksum,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function requireRow<T>(row: T | undefined, where: string): T {
  if (row === undefined) throw new Error(`${where} returned no row`);
  return row;
}
