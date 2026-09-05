import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import type { SystemAuthoring } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type {
  CharacterProjectionV1,
  DefinitionId,
  NormalizedRoll,
  RuntimeScalar,
  RuntimeStateV1,
  RuntimeValidation,
  SystemRuntime,
  VersionId,
} from "../systems/runtime.js";

import {
  createCharacterPersistenceRepository,
  type CharacterPersistenceRepository,
  type CharacterRecord,
} from "./persistence.js";
import { claimExecution } from "./idempotency.js";

export type { RequestContext } from "../systems/authoring.js";

export type CharacterId = string;
export type UserId = string;
export type ExecutionId = string;

const CREATE_COMMAND_KIND = "character_create";
const COMMAND_KIND: Record<CharacterCommand["kind"], string> = {
  setField: "character_set_field",
  bumpResource: "character_bump_resource",
  executeAction: "character_execute_action",
};
const LEASE_MS = 60 * 1000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGE_LIMIT = 100;
const NOT_FOUND_MESSAGE = "The requested character does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";
const ARCHIVED_MESSAGE = "Archived characters reject play commands until recovered.";
const IN_PROGRESS_MESSAGE = "Another request is already processing this idempotency key.";

export type CharacterErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "command_in_progress"
  | "invalid_value"
  | "internal";

export type CharacterError = {
  code: CharacterErrorCode;
  message: string;
  latestRevision?: number | null;
  diagnostics?: RuntimeValidation[];
  changedDefinitionIds?: DefinitionId[];
};

export type CharacterResult<T> = { ok: true; value: T } | { ok: false; error: CharacterError };

export type Reconciliation = {
  characterId: CharacterId;
  baseRevision: number | null;
  revision: number;
  packageChecksum: string;
  projectionVersion: "1.0";
  commandExecutionId: ExecutionId;
  replayExpiresAt: string;
  replayed: boolean;
  changedDefinitionIds: DefinitionId[];
  activityCursor: string | null;
  cacheDisposition: "retain" | "replace" | "purge";
};

export type CharacterView = {
  characterId: CharacterId;
  ownerId: UserId;
  name: string;
  systemVersionId: VersionId;
  entityDefinitionId: DefinitionId;
  revision: number;
  lifecycle: "active" | "archived";
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  state: RuntimeStateV1;
  derivedValues: Record<DefinitionId, RuntimeScalar>;
  validations: RuntimeValidation[];
  projection: CharacterProjectionV1;
  reconciliation: Reconciliation;
};

export type CharacterSummary = {
  characterId: CharacterId;
  name: string;
  entityDefinitionId: DefinitionId;
  systemVersionId: VersionId;
  revision: number;
  lifecycle: "active" | "archived";
  updatedAt: Date;
};

export type CharacterPage = {
  characters: CharacterSummary[];
  nextCursor: string | null;
};

export type CreateCharacter = {
  systemVersionId: VersionId;
  entityDefinitionId: DefinitionId;
  name: string;
  initialValues?: Record<DefinitionId, unknown>;
  idempotencyKey: string;
};

export type ListCharacters = {
  limit: number;
  cursor: string | null;
};

// ---------------------------------------------------------------------------
// Types for later slices (public contract defined now; implemented in Task 6+)
// ---------------------------------------------------------------------------

export type CharacterFieldSetCommand = {
  kind: "setField";
  characterId: CharacterId;
  fieldId: DefinitionId;
  value: unknown;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterResourceBumpCommand = {
  kind: "bumpResource";
  characterId: CharacterId;
  resourceId: DefinitionId;
  direction: "up" | "down";
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterActionCommand = {
  kind: "executeAction";
  characterId: CharacterId;
  actionId: DefinitionId;
  inputs: Record<DefinitionId, unknown>;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterCommand =
  | CharacterFieldSetCommand
  | CharacterResourceBumpCommand
  | CharacterActionCommand;

export type CharacterRenameCommand = {
  kind: "rename";
  characterId: CharacterId;
  name: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterTransferCommand = {
  kind: "transferOwnership";
  characterId: CharacterId;
  toUserId: UserId;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterArchiveCommand = {
  kind: "archive";
  characterId: CharacterId;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterRecoverCommand = {
  kind: "recover";
  characterId: CharacterId;
  expectedRevision: number;
  idempotencyKey: string;
};

export type CharacterManagementCommand =
  | CharacterRenameCommand
  | CharacterTransferCommand
  | CharacterArchiveCommand
  | CharacterRecoverCommand;

export type CharacterCommandResult = {
  character: CharacterView;
  roll: NormalizedRoll | null;
};

export type ListCharacterActivity = {
  characterId: CharacterId;
  limit: number;
  cursor: string | null;
};

export type CharacterActivityEvent = {
  id: string;
  characterRevision: number;
  kind: string;
  payload: unknown;
  rollId: string | null;
  requestId: string;
  occurredAt: Date;
};

export type CharacterActivityPage = {
  events: CharacterActivityEvent[];
  nextCursor: string | null;
};

export type ExportCharacter = { characterId: CharacterId };

export type CharacterExportV1 = {
  schemaVersion: "1.0";
  mediaType: "application/vnd.sweetroll.character+json;version=1";
  characterId: CharacterId;
  name: string;
  entityDefinitionId: DefinitionId;
  lifecycle: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  systemVersionId: VersionId;
  packageChecksum: string;
  revision: number;
  state: RuntimeStateV1;
  migrationLineage: Array<{ fromVersionId: VersionId; toVersionId: VersionId; committedAt: string }>;
};

export type PreviewCharacterMigration = {
  characterId: CharacterId;
  targetVersionId: VersionId;
  mappings?: Record<DefinitionId, DefinitionId>;
  defaults?: Record<DefinitionId, unknown>;
};

export type CharacterMigrationPreview = {
  previewId: string;
  characterId: CharacterId;
  sourceRevision: number;
  sourceVersionId: VersionId;
  targetVersionId: VersionId;
  candidateState: RuntimeStateV1;
  candidateProjection: CharacterProjectionV1;
  warnings: string[];
  expiresAt: string;
};

export type CommitCharacterMigration = {
  characterId: CharacterId;
  previewId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type RollbackCharacterMigration = {
  characterId: CharacterId;
  migrationId: string;
  idempotencyKey: string;
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Characters {
  create(ctx: RequestContext, input: CreateCharacter): Promise<CharacterResult<CharacterView>>;
  list(ctx: RequestContext, input: ListCharacters): Promise<CharacterResult<CharacterPage>>;
  open(ctx: RequestContext, characterId: CharacterId): Promise<CharacterResult<CharacterView>>;

  apply(ctx: RequestContext, input: CharacterCommand): Promise<CharacterResult<CharacterCommandResult>>;
  manage(
    ctx: RequestContext,
    input: CharacterManagementCommand,
  ): Promise<CharacterResult<CharacterCommandResult>>;

  listActivity(
    ctx: RequestContext,
    input: ListCharacterActivity,
  ): Promise<CharacterResult<CharacterActivityPage>>;
  exportCharacter(ctx: RequestContext, input: ExportCharacter): Promise<CharacterResult<CharacterExportV1>>;

  previewMigration(
    ctx: RequestContext,
    input: PreviewCharacterMigration,
  ): Promise<CharacterResult<CharacterMigrationPreview>>;
  commitMigration(
    ctx: RequestContext,
    input: CommitCharacterMigration,
  ): Promise<CharacterResult<CharacterCommandResult>>;
  rollbackMigration(
    ctx: RequestContext,
    input: RollbackCharacterMigration,
  ): Promise<CharacterResult<CharacterCommandResult>>;
}

export type CreateCharactersModuleInput = {
  pool: Pool;
  runtime: SystemRuntime;
  authorizeVersionUse: SystemAuthoring["authorizeVersionUse"];
  now?: () => Date;
  newId?: () => string;
  newExecutionId?: () => string;
};

export function createCharactersModule(input: CreateCharactersModuleInput): Characters {
  const repo: CharacterPersistenceRepository = createCharacterPersistenceRepository(input.pool);
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());
  const newExecutionId = input.newExecutionId ?? (() => randomUUID());

  const errors = {
    bad_request: (message: string): CharacterError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CharacterError => ({ code: "not_found", message }),
    mismatch: (): CharacterError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    inProgress: (): CharacterError => ({ code: "command_in_progress", message: IN_PROGRESS_MESSAGE }),
    archived: (): CharacterError => ({ code: "conflict", message: ARCHIVED_MESSAGE }),
    conflict: (latestRevision: number, changedDefinitionIds: DefinitionId[]): CharacterError => ({
      code: "conflict",
      message: "The character has a newer revision. Retry with the latest revision and a new idempotency key.",
      latestRevision,
      changedDefinitionIds,
    }),
    invalid_value: (message: string, diagnostics?: RuntimeValidation[]): CharacterError => ({
      code: "invalid_value",
      message,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
    internal: (): CharacterError => ({ code: "internal", message: "An internal error occurred." }),
    notImplemented: (): CharacterError => ({
      code: "internal",
      message: "This Characters capability is not implemented yet.",
    }),
  };

  function toSummary(record: CharacterRecord): CharacterSummary {
    return {
      characterId: record.characterId,
      name: record.name,
      entityDefinitionId: record.entityDefinitionId,
      systemVersionId: record.systemVersionId,
      revision: record.revision,
      lifecycle: record.lifecycle,
      updatedAt: record.updatedAt,
    };
  }

  function toView(
    record: CharacterRecord,
    resolved: {
      derivedValues: Record<DefinitionId, RuntimeScalar>;
      validations: RuntimeValidation[];
      projection: CharacterProjectionV1;
      packageChecksum: string;
      changedDefinitionIds: DefinitionId[];
    },
    reconciliationExtras: {
      baseRevision: number | null;
      commandExecutionId: ExecutionId;
      replayExpiresAt: string;
      replayed: boolean;
    },
  ): CharacterView {
    return {
      characterId: record.characterId,
      ownerId: record.ownerId,
      name: record.name,
      systemVersionId: record.systemVersionId,
      entityDefinitionId: record.entityDefinitionId,
      revision: record.revision,
      lifecycle: record.lifecycle,
      archivedAt: record.archivedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      state: record.state,
      derivedValues: resolved.derivedValues,
      validations: resolved.validations,
      projection: resolved.projection,
      reconciliation: {
        characterId: record.characterId,
        baseRevision: reconciliationExtras.baseRevision,
        revision: record.revision,
        packageChecksum: resolved.packageChecksum,
        projectionVersion: "1.0",
        commandExecutionId: reconciliationExtras.commandExecutionId,
        replayExpiresAt: reconciliationExtras.replayExpiresAt,
        replayed: reconciliationExtras.replayed,
        changedDefinitionIds: resolved.changedDefinitionIds,
        activityCursor: null,
        cacheDisposition: "retain",
      },
    };
  }

  function serializeView(view: CharacterView): unknown {
    return {
      ...view,
      archivedAt: view.archivedAt === null ? null : view.archivedAt.toISOString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    };
  }

  function deserializeView(stored: unknown): CharacterView {
    const raw = stored as Omit<CharacterView, "archivedAt" | "createdAt" | "updatedAt"> & {
      archivedAt: string | null;
      createdAt: string;
      updatedAt: string;
    };
    return {
      ...raw,
      archivedAt: raw.archivedAt === null ? null : new Date(raw.archivedAt),
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
    };
  }

  type StoredCommandOutcome =
    | { ok: true; value: { character: unknown; roll: NormalizedRoll | null } }
    | { ok: false; error: CharacterError };

  function serializeCommandError(error: CharacterError): StoredCommandOutcome {
    return { ok: false, error };
  }

  function replayStoredOutcome(resultJson: unknown): CharacterResult<CharacterCommandResult> {
    const stored = resultJson as StoredCommandOutcome;
    if (!stored.ok) return { ok: false, error: stored.error };
    const view = deserializeView(stored.value.character);
    return {
      ok: true,
      value: {
        character: { ...view, reconciliation: { ...view.reconciliation, replayed: true } },
        roll: stored.value.roll,
      },
    };
  }

  function mapRuntimeError(error: { code: string; message: string; definitionId?: string }): CharacterError {
    switch (error.code) {
      case "not_found":
        return errors.not_found("The published version or entity definition does not exist.");
      case "bad_request":
      case "invalid_state":
      case "unsupported_field_value":
      case "budget_exceeded":
        return errors.invalid_value(error.message);
      default:
        return errors.internal();
    }
  }

  return {
    async create(ctx, createInput) {
      try {
        const inputHash = hashInput({
          systemVersionId: createInput.systemVersionId,
          entityDefinitionId: createInput.entityDefinitionId,
          name: createInput.name,
          initialValues: createInput.initialValues ?? {},
        });

        const existing = await repo.loadExecution({
          actorId: ctx.actorId,
          commandKind: CREATE_COMMAND_KIND,
          idempotencyKey: createInput.idempotencyKey,
        });
        if (existing !== null) {
          if (existing.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          const replayedView = deserializeView(existing.resultJson);
          return {
            ok: true,
            value: { ...replayedView, reconciliation: { ...replayedView.reconciliation, replayed: true } },
          };
        }

        const authorized = await input.authorizeVersionUse(ctx, createInput.systemVersionId);
        if (!authorized.ok) return { ok: false, error: errors.not_found() };

        const resolved = await input.runtime.resolve({
          versionId: authorized.value.versionId,
          entityId: createInput.entityDefinitionId,
          intent:
            createInput.initialValues === undefined
              ? { kind: "initialize" }
              : { kind: "initialize", values: createInput.initialValues },
        });
        if (!resolved.ok) return { ok: false, error: mapRuntimeError(resolved.error) };

        const characterId = newId();
        const executionId = newExecutionId();
        const createdAt = now();
        const replayExpiresAt = new Date(createdAt.getTime() + REPLAY_TTL_MS);

        const provisionalRecord: CharacterRecord = {
          characterId,
          ownerId: ctx.actorId,
          systemVersionId: resolved.value.versionId,
          entityDefinitionId: createInput.entityDefinitionId,
          name: createInput.name,
          revision: 1,
          state: resolved.value.state,
          visibility: "owner_only",
          lifecycle: "active",
          archivedAt: null,
          createdAt,
          updatedAt: createdAt,
        };

        const view = toView(
          provisionalRecord,
          {
            derivedValues: resolved.value.derivedValues,
            validations: resolved.value.validations,
            projection: resolved.value.projection,
            packageChecksum: resolved.value.packageChecksum,
            changedDefinitionIds: [],
          },
          {
            baseRevision: null,
            commandExecutionId: executionId,
            replayExpiresAt: replayExpiresAt.toISOString(),
            replayed: false,
          },
        );

        const record = await repo.createCharacterTx({
          character: {
            characterId,
            ownerId: ctx.actorId,
            systemVersionId: resolved.value.versionId,
            entityDefinitionId: createInput.entityDefinitionId,
            name: createInput.name,
            state: resolved.value.state,
          },
          execution: {
            executionId,
            actorId: ctx.actorId,
            commandKind: CREATE_COMMAND_KIND,
            idempotencyKey: createInput.idempotencyKey,
            inputHash,
            resultJson: serializeView(view),
            expiresAt: replayExpiresAt,
          },
          activity: {
            kind: "character_created",
            payloadJson: { entityDefinitionId: createInput.entityDefinitionId },
            requestId: ctx.requestId,
          },
          audit: {
            actorId: ctx.actorId,
            kind: "character_created",
            summary: "Character created",
            requestId: ctx.requestId,
          },
        });

        return {
          ok: true,
          value: {
            ...view,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async list(ctx, listInput) {
      try {
        const limit = Math.trunc(listInput.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return {
            ok: false,
            error: errors.bad_request(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`),
          };
        }
        const cursor = decodeCursor(listInput.cursor);
        if (listInput.cursor !== null && cursor === null) {
          return { ok: false, error: errors.bad_request("cursor is malformed.") };
        }
        const records = await repo.listOwnedCharactersPage(ctx.actorId, { limit: limit + 1, cursor });
        const page = records.slice(0, limit);
        const nextCursor =
          records.length > limit
            ? encodeCursor({ updatedAt: page[page.length - 1]!.updatedAt, characterId: page[page.length - 1]!.characterId })
            : null;
        return {
          ok: true,
          value: { characters: page.map(toSummary), nextCursor },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async open(ctx, characterId) {
      try {
        const record = await repo.openOwnedCharacter(characterId, ctx.actorId);
        if (record === null) return { ok: false, error: errors.not_found() };

        const resolved = await input.runtime.resolve({
          versionId: record.systemVersionId,
          entityId: record.entityDefinitionId,
          state: record.state,
          intent: { kind: "observe" },
        });
        if (!resolved.ok) return { ok: false, error: mapRuntimeError(resolved.error) };

        const view = toView(
          record,
          {
            derivedValues: resolved.value.derivedValues,
            validations: resolved.value.validations,
            projection: resolved.value.projection,
            packageChecksum: resolved.value.packageChecksum,
            changedDefinitionIds: [],
          },
          {
            baseRevision: record.revision,
            commandExecutionId: newExecutionId(),
            replayExpiresAt: new Date(now().getTime() + REPLAY_TTL_MS).toISOString(),
            replayed: false,
          },
        );
        return { ok: true, value: view };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async apply(ctx, command) {
      try {
        if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) {
          return { ok: false, error: errors.bad_request("expectedRevision must be a positive integer.") };
        }

        if (command.kind === "executeAction") {
          return { ok: false, error: errors.notImplemented() };
        }

        const commandKind = COMMAND_KIND[command.kind];
        const payload =
          command.kind === "setField"
            ? { fieldId: command.fieldId, value: command.value }
            : { resourceId: command.resourceId, direction: command.direction };
        const inputHash = hashInput({
          commandKind,
          characterId: command.characterId,
          expectedRevision: command.expectedRevision,
          ...payload,
        });

        const claimStartedAt = now();
        const claimed = await claimExecution(input.pool, {
          actorId: ctx.actorId,
          commandKind,
          idempotencyKey: command.idempotencyKey,
          inputHash,
          newExecutionId,
          now: claimStartedAt,
          leaseMs: LEASE_MS,
          replayTtlMs: REPLAY_TTL_MS,
        });

        if (claimed.status === "mismatch") return { ok: false, error: errors.mismatch() };
        if (claimed.status === "in_progress") return { ok: false, error: errors.inProgress() };
        if (claimed.status === "replay") {
          return replayStoredOutcome(claimed.resultJson);
        }

        const executionId = claimed.executionId;
        const replayExpiresAt = new Date(claimStartedAt.getTime() + REPLAY_TTL_MS);

        const snapshot = await repo.openOwnedCharacter(command.characterId, ctx.actorId);
        if (snapshot === null) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }
        if (snapshot.lifecycle === "archived") {
          const error = errors.archived();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }

        const intent =
          command.kind === "setField"
            ? ({ kind: "set", fieldId: command.fieldId, value: command.value } as const)
            : ({ kind: "bump", resourceId: command.resourceId, direction: command.direction } as const);

        const resolved = await input.runtime.resolve({
          versionId: snapshot.systemVersionId,
          entityId: snapshot.entityDefinitionId,
          state: snapshot.state,
          intent,
        });
        if (!resolved.ok) {
          const error = mapRuntimeError(resolved.error);
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }

        const activityKind = command.kind === "setField" ? "character_field_set" : "character_resource_bumped";
        const changedDefinitionIds = resolved.value.changedDefinitionIds;

        const outcome = await repo.applyCommandTx({
          executionId,
          characterId: command.characterId,
          actorId: ctx.actorId,
          expectedRevision: command.expectedRevision,
          nextState: resolved.value.state,
          stateChanged: changedDefinitionIds.length > 0,
          activity: {
            kind: activityKind,
            payloadJson: { ...payload, changedDefinitionIds },
            requestId: ctx.requestId,
          },
          resultExpiresAt: replayExpiresAt,
          buildResult: ({ record }) => {
            const view = toView(
              record,
              {
                derivedValues: resolved.value.derivedValues,
                validations: resolved.value.validations,
                projection: resolved.value.projection,
                packageChecksum: resolved.value.packageChecksum,
                changedDefinitionIds,
              },
              {
                baseRevision: command.expectedRevision,
                commandExecutionId: executionId,
                replayExpiresAt: replayExpiresAt.toISOString(),
                replayed: false,
              },
            );
            return { ok: true, value: { character: serializeView(view), roll: null } };
          },
        });

        if (outcome.kind === "already_completed") {
          return replayStoredOutcome(outcome.resultJson);
        }
        if (outcome.kind === "not_found") {
          const error = errors.not_found();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }
        if (outcome.kind === "archived") {
          const error = errors.archived();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }
        if (outcome.kind === "conflict") {
          const changedSinceBase = await repo.changedDefinitionIdsSinceRevision(
            command.characterId,
            command.expectedRevision,
          );
          const error = errors.conflict(outcome.latestRevision, changedSinceBase);
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }

        const stored = outcome.resultJson as StoredCommandOutcome;
        if (!stored.ok) return { ok: false, error: stored.error };
        const view = deserializeView(stored.value.character);
        return { ok: true, value: { character: view, roll: stored.value.roll } };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
    async manage() {
      return { ok: false, error: errors.notImplemented() };
    },
    async listActivity() {
      return { ok: false, error: errors.notImplemented() };
    },
    async exportCharacter() {
      return { ok: false, error: errors.notImplemented() };
    },
    async previewMigration() {
      return { ok: false, error: errors.notImplemented() };
    },
    async commitMigration() {
      return { ok: false, error: errors.notImplemented() };
    },
    async rollbackMigration() {
      return { ok: false, error: errors.notImplemented() };
    },
  };
}

function encodeCursor(cursor: { updatedAt: Date; characterId: CharacterId }): string {
  const payload = JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), characterId: cursor.characterId });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): { updatedAt: Date; characterId: CharacterId } | null {
  if (cursor === null) return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      updatedAt: string;
      characterId: string;
    };
    if (typeof payload.updatedAt !== "string" || typeof payload.characterId !== "string") return null;
    const updatedAt = new Date(payload.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, characterId: payload.characterId };
  } catch {
    return null;
  }
}
