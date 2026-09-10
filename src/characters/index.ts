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
  type ManagementMutation,
} from "./persistence.js";
import { claimExecution } from "./idempotency.js";
import { buildCharacterExportDocument } from "./export.js";
import { buildCandidateValues, collectEditableFields, denyAttachedMigrationScope } from "./migration.js";

export type { RequestContext } from "../systems/authoring.js";

export type CharacterId = string;
export type UserId = string;
export type ExecutionId = string;

const CREATE_COMMAND_KIND = "character_create";
const DUPLICATE_COMMAND_KIND = "character_duplicate";
const COMMAND_KIND: Record<CharacterCommand["kind"], string> = {
  setField: "character_set_field",
  bumpResource: "character_bump_resource",
  executeAction: "character_execute_action",
};
const MANAGEMENT_COMMAND_KIND: Record<CharacterManagementCommand["kind"], string> = {
  rename: "character_rename",
  transferOwnership: "character_transfer_ownership",
  archive: "character_archive",
  recover: "character_recover",
};
const MANAGEMENT_ACTIVITY_KIND: Record<CharacterManagementCommand["kind"], string> = {
  rename: "character_renamed",
  transferOwnership: "character_ownership_transferred",
  archive: "character_archived",
  recover: "character_recovered",
};
const MANAGEMENT_AUDIT_KIND: Record<CharacterManagementCommand["kind"], string> = {
  rename: "character_renamed",
  transferOwnership: "character_ownership_transferred",
  archive: "character_archived",
  recover: "character_recovered",
};
const MANAGEMENT_AUDIT_SUMMARY: Record<CharacterManagementCommand["kind"], string> = {
  rename: "Character renamed",
  transferOwnership: "Character ownership transferred",
  archive: "Character archived",
  recover: "Character recovered",
};
const LEASE_MS = 60 * 1000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const ROLLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMMIT_COMMAND_KIND = "character_migration_commit";
const ROLLBACK_COMMAND_KIND = "character_migration_rollback";
const MAX_PAGE_LIMIT = 100;
const NOT_FOUND_MESSAGE = "The requested character does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";
const REPLAY_EXPIRED_MESSAGE = "The replay window for this idempotency key has expired. Retry with a new key.";
const ARCHIVED_MESSAGE = "Archived characters reject play commands until recovered.";
const IN_PROGRESS_MESSAGE = "Another request is already processing this idempotency key.";

export type CharacterErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "command_in_progress"
  | "invalid_value"
  | "internal"
  | "temporarily_unavailable";

export type CharacterError = {
  code: CharacterErrorCode;
  message: string;
  latestRevision?: number | null;
  diagnostics?: RuntimeValidation[];
  changedDefinitionIds?: DefinitionId[];
  activityCursor?: string | null;
  cacheDisposition?: "retain" | "replace" | "purge";
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
  /**
   * Standalone owner. NULL while attached to a campaign: attached views
   * represent campaign custody (campaignId/controllers) rather than
   * inventing an owner user. Existing standalone views keep this populated.
   */
  ownerId: UserId | null;
  /** Campaign custody; NULL for standalone characters (ownership union). */
  campaignId: string | null;
  /** Active controllers; empty for standalone characters. */
  controllers: UserId[];
  placementGeneration: number;
  /** Immutable adopter; NULL for standalone and campaign-created sheets. */
  returnOwnerId: UserId | null;
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

export type CharacterCreationOptions = {
  versionId: VersionId;
  packageChecksum: string;
  entities: { id: DefinitionId; label: string }[];
};

export type CreationOptionsInput = {
  systemVersionId: VersionId;
};

export type CreationVersionEntry = {
  versionId: VersionId;
  systemId: string;
  systemName: string;
  semanticVersion: string;
  createdAt: string;
};

export type CreationVersions = {
  versions: CreationVersionEntry[];
  nextCursor: string | null;
};

export type ListCreationVersions = {
  limit?: number;
  cursor?: string | null;
  q?: string | null;
  systemId?: string | null;
};

export type ListCharacters = {
  limit: number;
  cursor: string | null;
};

export type DuplicateCharacter = {
  characterId: CharacterId;
  idempotencyKey: string;
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
  creationOptions(
    ctx: RequestContext,
    input: CreationOptionsInput,
  ): Promise<CharacterResult<CharacterCreationOptions>>;
  listCreationVersions(
    ctx: RequestContext,
    input: ListCreationVersions,
  ): Promise<CharacterResult<CreationVersions>>;
  list(ctx: RequestContext, input: ListCharacters): Promise<CharacterResult<CharacterPage>>;
  duplicate(ctx: RequestContext, input: DuplicateCharacter): Promise<CharacterResult<CharacterView>>;
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
  listAuthorizedVersions: SystemAuthoring["listAuthorizedVersions"];
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
    notFoundPurge: (message: string = NOT_FOUND_MESSAGE): CharacterError => ({
      code: "not_found",
      message,
      cacheDisposition: "purge",
    }),
    mismatch: (): CharacterError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    replayExpired: (): CharacterError => ({ code: "conflict", message: REPLAY_EXPIRED_MESSAGE }),
    inProgress: (): CharacterError => ({ code: "command_in_progress", message: IN_PROGRESS_MESSAGE }),
    archived: (): CharacterError => ({ code: "conflict", message: ARCHIVED_MESSAGE }),
    conflict: (
      latestRevision: number,
      changedDefinitionIds: DefinitionId[],
      activityCursor: string | null,
    ): CharacterError => ({
      code: "conflict",
      message: "The character has a newer revision. Retry with the latest revision and a new idempotency key.",
      latestRevision,
      changedDefinitionIds,
      activityCursor,
      cacheDisposition: "replace",
    }),
    invalid_value: (message: string, diagnostics?: RuntimeValidation[]): CharacterError => ({
      code: "invalid_value",
      message,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
    internal: (): CharacterError => ({ code: "internal", message: "An internal error occurred." }),
    temporarilyUnavailable: (): CharacterError => ({
      code: "temporarily_unavailable",
      message: "A temporary infrastructure failure occurred.",
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
    placement?: { controllers: UserId[] },
  ): CharacterView {
    return {
      characterId: record.characterId,
      ownerId: record.ownerId,
      campaignId: record.campaignId,
      controllers: placement?.controllers ?? [],
      placementGeneration: record.placementGeneration,
      returnOwnerId: record.returnOwnerId,
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

  type StoredDuplicateOutcome =
    | { ok: true; value: { character: unknown } }
    | { ok: false; error: CharacterError };

  function serializeCommandError(error: CharacterError): StoredCommandOutcome {
    return { ok: false, error };
  }

  function serializeDuplicateError(error: CharacterError): StoredDuplicateOutcome {
    return { ok: false, error };
  }

  function replayDuplicateOutcome(resultJson: unknown): CharacterResult<CharacterView> {
    const stored = resultJson as StoredDuplicateOutcome;
    if (!stored.ok) return { ok: false, error: stored.error };
    const view = deserializeView(stored.value.character);
    return {
      ok: true,
      value: { ...view, reconciliation: { ...view.reconciliation, replayed: true } },
    };
  }

  // I6 Task 1: a completed execution must never disclose its saved sheet/roll
  // to an actor who no longer owns the character. Executions are actor-scoped,
  // but ownership can move (transfer) after completion, so every early replay
  // reauthorizes current ownership before replayStoredOutcome/replayDuplicateOutcome.
  // Denied replays return the same generic inaccessible error the method uses
  // for a foreign character, without invoking Runtime.
  //
  // I6 Task 4 extends the same discipline to placement scope: a stored
  // standalone outcome must never replay once the character is attached to a
  // campaign (ownership alone cannot authorize attached data), and the
  // in-transaction already_completed path rechecks scope instead of trusting
  // the pre-transaction snapshot. Denied replays use the method's existing
  // foreign-character error, without invoking Runtime.
  async function denyReplayUnlessOwner(
    ctx: RequestContext,
    characterId: CharacterId,
    denied: () => CharacterError,
  ): Promise<CharacterResult<never> | null> {
    const current = await repo.openOwnedCharacter(characterId, ctx.actorId);
    if (current !== null) return null;
    return { ok: false, error: denied() };
  }

  async function denyStoredOutcomeUnlessStandaloneOwned(
    ctx: RequestContext,
    characterId: CharacterId,
    denied: () => CharacterError,
  ): Promise<CharacterResult<never> | null> {
    const scope = await repo.loadCharacterScope(characterId);
    if (scope === null) return null;
    // Attached since the claim: the standalone receipt is inert. The caller
    // may still be the return owner or a controller, but this method cannot
    // serve campaign-placed data, so it denies exactly like a foreign id.
    if (scope.campaignId !== null) return { ok: false, error: denied() };
    if (scope.ownerId !== ctx.actorId) return { ok: false, error: denied() };
    return null;
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
      case "invalid_package":
        return errors.invalid_value(error.message);
      default:
        // Unrecognized/transient runtime codes (including the runtime's `internal`,
        // which SystemRuntime uses for temporary I/O failures such as package-load
        // errors) become temporarily_unavailable, not programmer-error internals.
        return errors.temporarilyUnavailable();
    }
  }

  // Only these runtime error codes are stable/deterministic for the same input and safe to
  // permanently finalize on the idempotency key. An unmapped code (including the runtime's
  // `internal` code, which SystemRuntime also uses for transient I/O failures such as package
  // load errors) must NOT finalize — the execution stays pending/reclaimable so a retry after
  // the lease expires gets a fresh attempt instead of a permanently baked-in error.
  const STABLE_RUNTIME_ERROR_CODES = new Set([
    "not_found",
    "bad_request",
    "invalid_state",
    "unsupported_field_value",
    "budget_exceeded",
    "invalid_package",
  ]);

  function isFinalizableRuntimeError(code: string): boolean {
    return STABLE_RUNTIME_ERROR_CODES.has(code);
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
          if (existing.expiresAt.getTime() <= now().getTime()) return { ok: false, error: errors.replayExpired() };
          const replayedView = deserializeView(existing.resultJson);
          const denial = await denyReplayUnlessOwner(ctx, replayedView.characterId, () => errors.not_found());
          if (denial !== null) return denial;
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
          campaignId: null,
          placementGeneration: 1,
          returnOwnerId: null,
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
            createdAt,
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

    async creationOptions(ctx, creationInput) {
      try {
        const authorized = await input.authorizeVersionUse(ctx, creationInput.systemVersionId);
        if (!authorized.ok) return { ok: false, error: errors.not_found() };

        const described = await input.runtime.describeVersion({ versionId: authorized.value.versionId });
        if (!described.ok) return { ok: false, error: mapRuntimeError(described.error) };

        return { ok: true, value: described.value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listCreationVersions(ctx, listInput) {
      try {
        const authorized = await input.listAuthorizedVersions(ctx, listInput);
        if (!authorized.ok) {
          if (authorized.error.code === "bad_request") {
            return { ok: false, error: errors.bad_request(authorized.error.message) };
          }
          return { ok: false, error: errors.internal() };
        }
        return {
          ok: true,
          value: { versions: authorized.value.versions, nextCursor: authorized.value.nextCursor },
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

    async duplicate(ctx, duplicateInput) {
      try {
        const claimStartedAt = now();
        const claimed = await claimExecution(input.pool, {
          actorId: ctx.actorId,
          commandKind: DUPLICATE_COMMAND_KIND,
          idempotencyKey: duplicateInput.idempotencyKey,
          inputHash: hashInput({
            commandKind: DUPLICATE_COMMAND_KIND,
            characterId: duplicateInput.characterId,
          }),
          newExecutionId,
          now: claimStartedAt,
          leaseMs: LEASE_MS,
          replayTtlMs: REPLAY_TTL_MS,
        });
        if (claimed.status === "mismatch") return { ok: false, error: errors.mismatch() };
        if (claimed.status === "in_progress") return { ok: false, error: errors.inProgress() };
        if (claimed.status === "expired") return { ok: false, error: errors.replayExpired() };
        if (claimed.status === "replay") {
          const stored = claimed.resultJson as StoredDuplicateOutcome;
          if (stored.ok) {
            const duplicateId = (stored.value.character as { characterId: CharacterId }).characterId;
            const denial = await denyReplayUnlessOwner(ctx, duplicateId, () => errors.notFoundPurge());
            if (denial !== null) return denial;
          }
          return replayDuplicateOutcome(claimed.resultJson);
        }

        const executionId = claimed.executionId;
        const replayExpiresAt = new Date(claimStartedAt.getTime() + REPLAY_TTL_MS);

        // Owner-only: a foreign id reads as generic not_found (purge) so the
        // response never leaks whether the character exists.
        const source = await repo.openOwnedCharacter(duplicateInput.characterId, ctx.actorId);
        if (source === null) {
          const error = errors.notFoundPurge();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeDuplicateError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }
        if (source.lifecycle === "archived") {
          const error = errors.archived();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeDuplicateError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }

        const resolved = await input.runtime.resolve({
          versionId: source.systemVersionId,
          entityId: source.entityDefinitionId,
          state: source.state,
          intent: { kind: "observe" },
        });
        if (!resolved.ok) {
          const error = mapRuntimeError(resolved.error);
          if (isFinalizableRuntimeError(resolved.error.code)) {
            await repo.finalizeExecutionError({
              executionId,
              resultJson: serializeDuplicateError(error),
              expiresAt: replayExpiresAt,
            });
          }
          return { ok: false, error };
        }

        const duplicateId = newId();
        const createdAt = now();
        // Detach from the source record: the copy owns its state object.
        const copiedState = structuredClone(source.state);
        const outcome = await repo.duplicateCharacterTx({
          executionId,
          duplicate: {
            characterId: duplicateId,
            ownerId: ctx.actorId,
            systemVersionId: source.systemVersionId,
            entityDefinitionId: source.entityDefinitionId,
            name: source.name,
            state: copiedState,
            createdAt,
          },
          activity: {
            kind: "character_duplicated",
            payloadJson: { sourceCharacterId: source.characterId },
            requestId: ctx.requestId,
          },
          audit: {
            kind: "character_duplicated",
            summary: "Character duplicated",
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
                changedDefinitionIds: [],
              },
              {
                baseRevision: null,
                commandExecutionId: executionId,
                replayExpiresAt: replayExpiresAt.toISOString(),
                replayed: false,
              },
            );
            return { ok: true, value: { character: serializeView(view) } };
          },
        });

        if (outcome.kind === "already_completed") {
          // The duplicate copy may have been adopted since the claim: recheck
          // placement scope before disclosing the stored sheet. Stored error
          // outcomes carry no sheet and replay unchanged.
          const stored = outcome.resultJson as StoredDuplicateOutcome;
          if (stored.ok) {
            const duplicateId = (stored.value.character as { characterId: CharacterId }).characterId;
            const placementDenial = await denyStoredOutcomeUnlessStandaloneOwned(
              ctx,
              duplicateId,
              () => errors.notFoundPurge(),
            );
            if (placementDenial !== null) return placementDenial;
          }
          return replayDuplicateOutcome(outcome.resultJson);
        }
        const stored = outcome.resultJson as StoredDuplicateOutcome;
        if (!stored.ok) return { ok: false, error: stored.error };
        return { ok: true, value: deserializeView(stored.value.character) };
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

        const commandKind = COMMAND_KIND[command.kind];
        const payload =
          command.kind === "setField"
            ? { fieldId: command.fieldId, value: command.value }
            : command.kind === "bumpResource"
              ? { resourceId: command.resourceId, direction: command.direction }
              : { actionId: command.actionId, inputs: command.inputs };
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
        if (claimed.status === "expired") return { ok: false, error: errors.replayExpired() };
        if (claimed.status === "replay") {
          const denial = await denyReplayUnlessOwner(ctx, command.characterId, () => errors.not_found());
          if (denial !== null) return denial;
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
            : command.kind === "bumpResource"
              ? ({ kind: "bump", resourceId: command.resourceId, direction: command.direction } as const)
              : ({
                  kind: "action",
                  actionId: command.actionId,
                  inputs: command.inputs,
                  executionId,
                } as const);

        const resolved = await input.runtime.resolve({
          versionId: snapshot.systemVersionId,
          entityId: snapshot.entityDefinitionId,
          state: snapshot.state,
          intent,
        });
        if (!resolved.ok) {
          const error = mapRuntimeError(resolved.error);
          if (isFinalizableRuntimeError(resolved.error.code)) {
            await repo.finalizeExecutionError({
              executionId,
              resultJson: serializeCommandError(error),
              expiresAt: replayExpiresAt,
            });
          }
          return { ok: false, error };
        }

        const activityKind =
          command.kind === "setField"
            ? "character_field_set"
            : command.kind === "bumpResource"
              ? "character_resource_bumped"
              : "character_action_executed";
        const changedDefinitionIds = resolved.value.changedDefinitionIds;
        const roll = resolved.value.roll;

        const outcome = await repo.applyCommandTx({
          executionId,
          characterId: command.characterId,
          actorId: ctx.actorId,
          expectedRevision: command.expectedRevision,
          nextState: resolved.value.state,
          stateChanged: changedDefinitionIds.length > 0,
          roll,
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
            return { ok: true, value: { character: serializeView(view), roll } };
          },
        });

        if (outcome.kind === "already_completed") {
          const placementDenial = await denyStoredOutcomeUnlessStandaloneOwned(
            ctx,
            command.characterId,
            () => errors.not_found(),
          );
          if (placementDenial !== null) return placementDenial;
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
          const activityCursor =
            changedSinceBase.latestActivity === null ? null : encodeActivityCursor(changedSinceBase.latestActivity);
          const error = errors.conflict(outcome.latestRevision, changedSinceBase.changedDefinitionIds, activityCursor);
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
    async manage(ctx, command) {
      try {
        if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) {
          return { ok: false, error: errors.bad_request("expectedRevision must be a positive integer.") };
        }
        if (command.kind === "rename" && command.name.trim().length === 0) {
          return { ok: false, error: errors.bad_request("name must not be empty.") };
        }

        const commandKind = MANAGEMENT_COMMAND_KIND[command.kind];
        const payload =
          command.kind === "rename"
            ? { name: command.name }
            : command.kind === "transferOwnership"
              ? { toUserId: command.toUserId }
              : {};
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
        if (claimed.status === "expired") return { ok: false, error: errors.replayExpired() };
        if (claimed.status === "replay") {
          const denial = await denyReplayUnlessOwner(ctx, command.characterId, () => errors.notFoundPurge());
          if (denial !== null) return denial;
          return replayStoredOutcome(claimed.resultJson);
        }

        const executionId = claimed.executionId;
        const replayExpiresAt = new Date(claimStartedAt.getTime() + REPLAY_TTL_MS);

        const snapshot = await repo.openOwnedCharacter(command.characterId, ctx.actorId);
        if (snapshot === null) {
          const error = errors.notFoundPurge();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }

        // Management commands never mutate character state, so it is safe to resolve the
        // projection from the pre-mutation snapshot (immutable pinned version/package).
        const resolved = await input.runtime.resolve({
          versionId: snapshot.systemVersionId,
          entityId: snapshot.entityDefinitionId,
          state: snapshot.state,
          intent: { kind: "observe" },
        });
        if (!resolved.ok) {
          const error = mapRuntimeError(resolved.error);
          if (isFinalizableRuntimeError(resolved.error.code)) {
            await repo.finalizeExecutionError({
              executionId,
              resultJson: serializeCommandError(error),
              expiresAt: replayExpiresAt,
            });
          }
          return { ok: false, error };
        }

        const mutation: ManagementMutation =
          command.kind === "rename"
            ? { kind: "rename", name: command.name }
            : command.kind === "transferOwnership"
              ? { kind: "transferOwnership", toUserId: command.toUserId }
              : command.kind === "archive"
                ? { kind: "archive" }
                : { kind: "recover" };

        const outcome = await repo.applyManagementCommandTx({
          executionId,
          characterId: command.characterId,
          actorId: ctx.actorId,
          expectedRevision: command.expectedRevision,
          mutation,
          activity: {
            kind: MANAGEMENT_ACTIVITY_KIND[command.kind],
            payloadJson: payload,
            requestId: ctx.requestId,
          },
          audit: {
            kind: MANAGEMENT_AUDIT_KIND[command.kind],
            summary: MANAGEMENT_AUDIT_SUMMARY[command.kind],
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
                changedDefinitionIds: [],
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
          const placementDenial = await denyStoredOutcomeUnlessStandaloneOwned(
            ctx,
            command.characterId,
            () => errors.notFoundPurge(),
          );
          if (placementDenial !== null) return placementDenial;
          return replayStoredOutcome(outcome.resultJson);
        }
        if (outcome.kind === "not_found") {
          const error = errors.notFoundPurge();
          await repo.finalizeExecutionError({
            executionId,
            resultJson: serializeCommandError(error),
            expiresAt: replayExpiresAt,
          });
          return { ok: false, error };
        }
        if (outcome.kind === "invalid_target") {
          const error = errors.invalid_value("The destination user does not exist.");
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
          const activityCursor =
            changedSinceBase.latestActivity === null ? null : encodeActivityCursor(changedSinceBase.latestActivity);
          const error = errors.conflict(outcome.latestRevision, changedSinceBase.changedDefinitionIds, activityCursor);
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
    async listActivity(ctx, listInput) {
      try {
        const limit = Math.trunc(listInput.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
          return {
            ok: false,
            error: errors.bad_request(`limit must be an integer from 1 through ${MAX_PAGE_LIMIT}.`),
          };
        }
        const cursor = decodeActivityCursor(listInput.cursor);
        if (listInput.cursor !== null && cursor === null) {
          return { ok: false, error: errors.bad_request("cursor is malformed.") };
        }

        const character = await repo.openOwnedCharacter(listInput.characterId, ctx.actorId);
        if (character === null) return { ok: false, error: errors.notFoundPurge() };

        const rows = await repo.listActivityPage(listInput.characterId, { limit: limit + 1, cursor });
        const page = rows.slice(0, limit);
        const nextCursor =
          rows.length > limit
            ? encodeActivityCursor({ occurredAtText: page[page.length - 1]!.cursorText, id: page[page.length - 1]!.id })
            : null;

        return {
          ok: true,
          value: {
            events: page.map((row) => ({
              id: row.id,
              characterRevision: row.characterRevision,
              kind: row.kind,
              payload: minimizeActivityPayload(row.kind, row.payloadJson),
              rollId: row.rollId,
              requestId: row.requestId,
              occurredAt: row.occurredAt,
            })),
            nextCursor,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
    async exportCharacter(ctx, exportInput) {
      try {
        const record = await repo.openOwnedCharacter(exportInput.characterId, ctx.actorId);
        if (record === null) return { ok: false, error: errors.notFoundPurge() };

        const resolved = await input.runtime.resolve({
          versionId: record.systemVersionId,
          entityId: record.entityDefinitionId,
          state: record.state,
          intent: { kind: "observe" },
        });
        if (!resolved.ok) return { ok: false, error: mapRuntimeError(resolved.error) };

        const document = buildCharacterExportDocument(record, resolved.value.packageChecksum);

        await repo.recordAudit({
          characterId: record.characterId,
          actorId: ctx.actorId,
          kind: "character_exported",
          summary: "Character exported",
          requestId: ctx.requestId,
        });

        return { ok: true, value: document };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
    async previewMigration(ctx, migrationInput) {
      try {
        const character = await repo.openOwnedCharacter(migrationInput.characterId, ctx.actorId);
        if (character === null) return { ok: false, error: errors.notFoundPurge() };
        // Attached sheets deny migration preview instead of repinning: the
        // owner-only lookup above already rejects them (NULL owner_id), this
        // gate holds even if that lookup ever widens.
        if (denyAttachedMigrationScope(character) !== null) {
          return { ok: false, error: errors.notFoundPurge() };
        }
        // Standalone rows always carry an owner; the lookup above guarantees it.
        const previewOwnerId = character.ownerId;
        if (previewOwnerId === null) return { ok: false, error: errors.notFoundPurge() };

        const authorized = await input.authorizeVersionUse(ctx, migrationInput.targetVersionId);
        if (!authorized.ok) return { ok: false, error: errors.not_found() };

        const sourceIdentity = await repo.loadVersionIdentity(character.systemVersionId);
        if (sourceIdentity === null) return { ok: false, error: errors.not_found() };
        if (sourceIdentity.systemId !== authorized.value.systemId) {
          return {
            ok: false,
            error: errors.invalid_value(
              "The target version does not belong to the same system as the character.",
            ),
          };
        }

        const sourceResolved = await input.runtime.resolve({
          versionId: character.systemVersionId,
          entityId: character.entityDefinitionId,
          state: character.state,
          intent: { kind: "observe" },
        });
        if (!sourceResolved.ok) return { ok: false, error: mapRuntimeError(sourceResolved.error) };

        const targetSeed = await input.runtime.resolve({
          versionId: authorized.value.versionId,
          entityId: character.entityDefinitionId,
          intent: { kind: "initialize" },
        });
        if (!targetSeed.ok) return { ok: false, error: mapRuntimeError(targetSeed.error) };

        const sourceFields = collectEditableFields(
          sourceResolved.value.projection,
          Object.keys(character.state.values),
        );
        const targetFields = collectEditableFields(
          targetSeed.value.projection,
          Object.keys(targetSeed.value.state.values),
        );

        const built = buildCandidateValues({
          sourceState: character.state,
          sourceFields,
          targetFields,
          mappings: migrationInput.mappings ?? {},
          defaults: migrationInput.defaults ?? {},
        });
        if (!built.ok) return { ok: false, error: errors.invalid_value(built.error.message) };

        const candidate = await input.runtime.resolve({
          versionId: authorized.value.versionId,
          entityId: character.entityDefinitionId,
          intent: { kind: "initialize", values: built.values },
        });
        if (!candidate.ok) return { ok: false, error: mapRuntimeError(candidate.error) };

        const previewId = newId();
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
        const previewChecksum = hashInput({
          characterId: character.characterId,
          sourceRevision: character.revision,
          sourceVersionId: character.systemVersionId,
          sourceChecksum: sourceIdentity.checksum,
          targetVersionId: authorized.value.versionId,
          targetChecksum: authorized.value.checksum,
          mappings: migrationInput.mappings ?? {},
          defaults: migrationInput.defaults ?? {},
          candidateState: candidate.value.state,
          candidateProjection: candidate.value.projection,
          warnings: built.warnings,
          owner: previewOwnerId,
          expiresAt: expiresAt.toISOString(),
        });

        await repo.insertMigrationPreview({
          previewId,
          characterId: character.characterId,
          ownerId: previewOwnerId,
          sourceRevision: character.revision,
          sourceVersionId: character.systemVersionId,
          sourceChecksum: sourceIdentity.checksum,
          targetVersionId: authorized.value.versionId,
          targetChecksum: authorized.value.checksum,
          mappingJson: { mappings: migrationInput.mappings ?? {}, defaults: migrationInput.defaults ?? {} },
          candidateState: candidate.value.state,
          candidateProjection: candidate.value.projection,
          warnings: built.warnings,
          previewChecksum,
          expiresAt,
          audit: {
            actorId: ctx.actorId,
            kind: "character_migration_previewed",
            summary: "Character migration preview built",
            requestId: ctx.requestId,
          },
        });

        return {
          ok: true,
          value: {
            previewId,
            characterId: character.characterId,
            sourceRevision: character.revision,
            sourceVersionId: character.systemVersionId,
            targetVersionId: authorized.value.versionId,
            candidateState: candidate.value.state,
            candidateProjection: candidate.value.projection,
            warnings: built.warnings,
            expiresAt: expiresAt.toISOString(),
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
    async commitMigration(ctx, commitInput) {
      try {
        if (!Number.isInteger(commitInput.expectedRevision) || commitInput.expectedRevision < 1) {
          return { ok: false, error: errors.bad_request("expectedRevision must be a positive integer.") };
        }

        const claimStartedAt = now();
        const claimed = await claimExecution(input.pool, {
          actorId: ctx.actorId,
          commandKind: COMMIT_COMMAND_KIND,
          idempotencyKey: commitInput.idempotencyKey,
          inputHash: hashInput({
            commandKind: COMMIT_COMMAND_KIND,
            characterId: commitInput.characterId,
            previewId: commitInput.previewId,
            expectedRevision: commitInput.expectedRevision,
          }),
          newExecutionId,
          now: claimStartedAt,
          leaseMs: LEASE_MS,
          replayTtlMs: REPLAY_TTL_MS,
        });
        if (claimed.status === "mismatch") return { ok: false, error: errors.mismatch() };
        if (claimed.status === "in_progress") return { ok: false, error: errors.inProgress() };
        if (claimed.status === "expired") return { ok: false, error: errors.replayExpired() };
        if (claimed.status === "replay") {
          const denial = await denyReplayUnlessOwner(ctx, commitInput.characterId, () => errors.not_found());
          if (denial !== null) return denial;
          return replayStoredOutcome(claimed.resultJson);
        }
        const executionId = claimed.executionId;
        const replayExpiresAt = new Date(claimStartedAt.getTime() + REPLAY_TTL_MS);

        const character = await repo.openOwnedCharacter(commitInput.characterId, ctx.actorId);
        if (character === null) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        // Attached sheets deny migration commit instead of repinning campaign state.
        if (denyAttachedMigrationScope(character) !== null) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (character.lifecycle === "archived") {
          const error = errors.archived();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }

        const preview = await repo.loadMigrationPreview(commitInput.previewId);
        if (preview === null || preview.characterId !== commitInput.characterId || preview.ownerId !== ctx.actorId) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (preview.sourceRevision !== character.revision) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (preview.consumedAt !== null) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (new Date(preview.expiresAt).getTime() <= claimStartedAt.getTime()) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }

        const observed = await input.runtime.resolve({
          versionId: preview.targetVersionId,
          entityId: character.entityDefinitionId,
          state: preview.candidateState,
          intent: { kind: "observe" },
        });
        if (!observed.ok) {
          const error = mapRuntimeError(observed.error);
          if (isFinalizableRuntimeError(observed.error.code)) {
            await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          }
          return { ok: false, error };
        }

        const targetIdentity = await repo.loadVersionIdentity(preview.targetVersionId);
        if (targetIdentity === null) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }

        const outcome = await repo.commitMigrationTx({
          executionId,
          characterId: commitInput.characterId,
          actorId: ctx.actorId,
          expectedRevision: commitInput.expectedRevision,
          previewId: commitInput.previewId,
          sourceRevision: preview.sourceRevision,
          sourceVersionId: preview.sourceVersionId,
          sourceChecksum: preview.sourceChecksum,
          targetVersionId: preview.targetVersionId,
          targetChecksum: preview.targetChecksum,
          previewChecksum: preview.previewChecksum,
          candidateState: preview.candidateState,
          beforeState: character.state,
          rollbackDeadline: new Date(claimStartedAt.getTime() + ROLLBACK_TTL_MS),
          now: claimStartedAt,
          activity: {
            kind: "character_migration_committed",
            payloadJson: { previewId: commitInput.previewId, targetVersionId: preview.targetVersionId },
            requestId: ctx.requestId,
          },
          audit: {
            actorId: ctx.actorId,
            kind: "character_migration_committed",
            summary: "Character migration committed",
            requestId: ctx.requestId,
          },
          resultExpiresAt: replayExpiresAt,
          buildResult: ({ record }) => {
            const view = toView(
              record,
              {
                derivedValues: observed.value.derivedValues,
                validations: observed.value.validations,
                projection: observed.value.projection,
                packageChecksum: observed.value.packageChecksum,
                changedDefinitionIds: [],
              },
              {
                baseRevision: commitInput.expectedRevision,
                commandExecutionId: executionId,
                replayExpiresAt: replayExpiresAt.toISOString(),
                replayed: false,
              },
            );
            return { ok: true, value: { character: serializeView(view), roll: null } };
          },
        });

        if (outcome.kind === "already_completed") {
          const placementDenial = await denyStoredOutcomeUnlessStandaloneOwned(
            ctx,
            commitInput.characterId,
            () => errors.not_found(),
          );
          if (placementDenial !== null) return placementDenial;
          return replayStoredOutcome(outcome.resultJson);
        }
        if (outcome.kind === "not_found") {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (outcome.kind === "conflict") {
          const error = errors.conflict(outcome.latestRevision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (outcome.kind === "consumed" || outcome.kind === "expired") {
          const error = errors.conflict(outcome.latestRevision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
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
    async rollbackMigration(ctx, rollbackInput) {
      try {
        const claimStartedAt = now();
        const claimed = await claimExecution(input.pool, {
          actorId: ctx.actorId,
          commandKind: ROLLBACK_COMMAND_KIND,
          idempotencyKey: rollbackInput.idempotencyKey,
          inputHash: hashInput({
            commandKind: ROLLBACK_COMMAND_KIND,
            characterId: rollbackInput.characterId,
            migrationId: rollbackInput.migrationId,
          }),
          newExecutionId,
          now: claimStartedAt,
          leaseMs: LEASE_MS,
          replayTtlMs: REPLAY_TTL_MS,
        });
        if (claimed.status === "mismatch") return { ok: false, error: errors.mismatch() };
        if (claimed.status === "in_progress") return { ok: false, error: errors.inProgress() };
        if (claimed.status === "expired") return { ok: false, error: errors.replayExpired() };
        if (claimed.status === "replay") {
          const denial = await denyReplayUnlessOwner(ctx, rollbackInput.characterId, () => errors.notFoundPurge());
          if (denial !== null) return denial;
          return replayStoredOutcome(claimed.resultJson);
        }
        const executionId = claimed.executionId;
        const replayExpiresAt = new Date(claimStartedAt.getTime() + REPLAY_TTL_MS);

        const migration = await repo.loadMigration({
          migrationId: rollbackInput.migrationId,
          characterId: rollbackInput.characterId,
          actorId: ctx.actorId,
        });
        if (migration === null) {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }

        const character = await repo.openOwnedCharacter(rollbackInput.characterId, ctx.actorId);
        if (character === null) {
          const error = errors.notFoundPurge();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        // Attached sheets deny migration rollback instead of restoring campaign state.
        if (denyAttachedMigrationScope(character) !== null) {
          const error = errors.notFoundPurge();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (character.revision !== migration.commitRevision) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (migration.rolledBackAt !== null) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (new Date(migration.rollbackDeadline).getTime() <= claimStartedAt.getTime()) {
          const error = errors.conflict(character.revision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }

        const restored = await input.runtime.resolve({
          versionId: migration.sourceVersionId,
          entityId: character.entityDefinitionId,
          state: migration.beforeState,
          intent: { kind: "observe" },
        });
        if (!restored.ok) {
          const error = mapRuntimeError(restored.error);
          if (isFinalizableRuntimeError(restored.error.code)) {
            await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          }
          return { ok: false, error };
        }

        const outcome = await repo.rollbackMigrationTx({
          executionId,
          characterId: rollbackInput.characterId,
          actorId: ctx.actorId,
          migration,
          sourceVersionId: migration.sourceVersionId,
          sourceState: migration.beforeState,
          now: claimStartedAt,
          activity: {
            kind: "character_migration_rolled_back",
            payloadJson: { migrationId: rollbackInput.migrationId },
            requestId: ctx.requestId,
          },
          audit: {
            actorId: ctx.actorId,
            kind: "character_migration_rolled_back",
            summary: "Character migration rolled back",
            requestId: ctx.requestId,
          },
          resultExpiresAt: replayExpiresAt,
          buildResult: ({ record }) => {
            const view = toView(
              record,
              {
                derivedValues: restored.value.derivedValues,
                validations: restored.value.validations,
                projection: restored.value.projection,
                packageChecksum: restored.value.packageChecksum,
                changedDefinitionIds: [],
              },
              {
                baseRevision: character.revision,
                commandExecutionId: executionId,
                replayExpiresAt: replayExpiresAt.toISOString(),
                replayed: false,
              },
            );
            return { ok: true, value: { character: serializeView(view), roll: null } };
          },
        });

        if (outcome.kind === "already_completed") {
          const placementDenial = await denyStoredOutcomeUnlessStandaloneOwned(
            ctx,
            rollbackInput.characterId,
            () => errors.notFoundPurge(),
          );
          if (placementDenial !== null) return placementDenial;
          return replayStoredOutcome(outcome.resultJson);
        }
        if (outcome.kind === "not_found") {
          const error = errors.not_found();
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
          return { ok: false, error };
        }
        if (outcome.kind === "conflict") {
          const error = errors.conflict(outcome.latestRevision, [], null);
          await repo.finalizeExecutionError({ executionId, resultJson: serializeCommandError(error), expiresAt: replayExpiresAt });
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
  };
}

function encodeActivityCursor(cursor: { occurredAtText: string; id: string }): string {
  const payload = JSON.stringify({ occurredAt: cursor.occurredAtText, id: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeActivityCursor(cursor: string | null): { occurredAtText: string; id: string } | null {
  if (cursor === null) return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      occurredAt: string;
      id: string;
    };
    if (typeof payload.occurredAt !== "string" || typeof payload.id !== "string") return null;
    const parsed = new Date(payload.occurredAt);
    if (Number.isNaN(parsed.getTime())) return null;
    return { occurredAtText: payload.occurredAt, id: payload.id };
  } catch {
    return null;
  }
}

// Activity pagination must never expose raw state values (or other stored input like action
// inputs), email, external identity, session, or idempotency keys. Only structural identifiers
// needed to interpret "what happened" are retained; the underlying write-side payload (in
// persistence.ts) may include more, but the read-side projection here minimizes it.
function minimizeActivityPayload(kind: string, payload: unknown): unknown {
  const record = payload as Record<string, unknown> | null | undefined;
  if (record === null || record === undefined || typeof record !== "object") return {};
  switch (kind) {
    case "character_created":
      return { entityDefinitionId: record.entityDefinitionId };
    case "character_field_set":
      return { fieldId: record.fieldId, changedDefinitionIds: record.changedDefinitionIds ?? [] };
    case "character_resource_bumped":
      return {
        resourceId: record.resourceId,
        direction: record.direction,
        changedDefinitionIds: record.changedDefinitionIds ?? [],
      };
    case "character_action_executed":
      return { actionId: record.actionId, changedDefinitionIds: record.changedDefinitionIds ?? [] };
    case "character_renamed":
      return { name: record.name };
    case "character_ownership_transferred":
      return {};
    case "character_archived":
    case "character_recovered":
      return {};
    default:
      return {};
  }
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
