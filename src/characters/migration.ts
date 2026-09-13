import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { RequestContext, SystemAuthoring } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type {
  CharacterProjectionV1,
  CharacterProjectionElement,
  DefinitionId,
  RuntimeStateV1,
  SystemRuntime,
} from "../systems/runtime.js";
import type {
  CharacterCommandResult,
  CharacterError,
  CharacterMigrationPreview,
  CharacterResult,
  CharacterView,
  CommitCharacterMigration,
  PreviewCharacterMigration,
} from "./index.js";
import type { CharacterLifecycle, CharacterRecord } from "./persistence.js";

/**
 * Deterministic definition-ID mapping between a source and target published
 * package for one character. This module never interprets package source or
 * ASTs; it consumes only the public runtime projections and calls back through
 * SystemRuntime for final validation. No executable migration code is stored.
 */

/**
 * I6 Task 4 scope gate for the migration feature: attached characters must
 * deny preview/commit/rollback instead of repinning or copying campaign
 * state. Owner-only lookups already reject attached rows (their owner_id is
 * NULL), so commit/rollback check this gate scope-first (before the ownership
 * lookup) and keep a second identical check right after it; preview checks it
 * right after its ownership lookup. Either layer denies on its own.
 */
export function denyAttachedMigrationScope(record: {
  ownerId: string | null;
  campaignId: string | null;
}): { attached: true } | null {
  if (record.campaignId !== null) return { attached: true };
  return null;
}

export type EditableFieldDef = {
  id: DefinitionId;
  fieldKind: string;
  required: boolean;
  constraints: Record<string, unknown>;
};

const COMPUTED_KIND = "computed";
const EDGE_KINDS = new Set(["heading", "action"]);

function elementFieldId(element: CharacterProjectionElement): DefinitionId | null {
  switch (element.kind) {
    case "field":
      return element.fieldId;
    case "resource":
      return element.resourceId;
    default:
      return null;
  }
}

function elementInfo(element: CharacterProjectionElement): {
  fieldKind: string;
  required: boolean;
  constraints: Record<string, unknown>;
} | null {
  switch (element.kind) {
    case "field":
      return {
        fieldKind: element.fieldKind,
        required: element.constraints?.required === true,
        constraints: (element.constraints ?? {}) as Record<string, unknown>,
      };
    case "resource":
      return {
        fieldKind: "resource",
        required: false,
        constraints: { min: element.min, max: element.max, step: element.step, resetTo: element.resetTo },
      };
    default:
      return null;
  }
}

/**
 * Collects the editable (non-computed) field definitions from a projection,
 * plus any editable fields present in the stored/initialized state but absent
 * from the sheet layout. Computed fields and structural elements are excluded.
 *
 * State-only fields carry an unknown kind: without a projection entry their
 * type cannot be verified, so they are never treated as compatible for
 * same-ID carry and only ever fall back to their target default.
 */
export function collectEditableFields(
  projection: CharacterProjectionV1,
  stateKeys?: string[],
): Map<DefinitionId, EditableFieldDef> {
  const fields = new Map<DefinitionId, EditableFieldDef>();
  for (const sheet of projection.sheets) {
    for (const section of sheet.sections) {
      for (const element of section.elements) {
        if (EDGE_KINDS.has(element.kind)) continue;
        const fieldId = elementFieldId(element);
        const info = elementInfo(element);
        if (fieldId === null || info === null) continue;
        if (info.fieldKind === COMPUTED_KIND) continue;
        fields.set(fieldId, {
          id: fieldId,
          fieldKind: info.fieldKind,
          required: info.required,
          constraints: info.constraints,
        });
      }
    }
  }
  if (stateKeys !== undefined) {
    for (const key of stateKeys) {
      if (fields.has(key)) continue;
      fields.set(key, { id: key, fieldKind: "unknown", required: false, constraints: {} });
    }
  }
  return fields;
}

export type MigrationBuildFailureCode = "invalid_mapping" | "invalid_default" | "duplicate_target";

export type BuildCandidateResult =
  | { ok: true; values: Record<DefinitionId, unknown>; warnings: string[] }
  | { ok: false; error: { code: MigrationBuildFailureCode; message: string } };

function constraintsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

/**
 * Builds the candidate `initialize` values and human-readable warnings for a
 * migration preview from the source state, both projections, explicit
 * source-to-target mappings, and literal defaults.
 *
 * Rules:
 * - Same-ID source fields whose kind still exists in the target are retained by
 *   same ID.
 * - Explicit `{ sourceFieldId: targetFieldId }` mappings rename a source value.
 * - Literal defaults keyed by target field supply values for otherwise-new or
 *   incompatible target fields.
 * - Duplicate targets and references to unknown source/target fields are rejected.
 * - Dropped source IDs, defaulted target IDs, and tightened constraints are
 *   reported as warnings. Final type/shape validation is delegated to the
 *   target Runtime `initialize`.
 */
export function buildCandidateValues(input: {
  sourceState: RuntimeStateV1;
  sourceFields: Map<DefinitionId, EditableFieldDef>;
  targetFields: Map<DefinitionId, EditableFieldDef>;
  mappings: Record<DefinitionId, DefinitionId>;
  defaults: Record<DefinitionId, unknown>;
}): BuildCandidateResult {
  const { sourceState, sourceFields, targetFields } = input;

  const ownedTargets = new Map<DefinitionId, DefinitionId>(); // sourceId -> targetId for explicit maps
  const targetSuppliedBy = new Map<DefinitionId, DefinitionId>(); // targetId -> sourceId

  for (const [sourceId, targetId] of Object.entries(input.mappings)) {
    const sourceField = sourceFields.get(sourceId);
    if (sourceField === undefined) {
      return {
        ok: false,
        error: { code: "invalid_mapping", message: `Source field "${sourceId}" does not exist on this character.` },
      };
    }
    const targetField = targetFields.get(targetId);
    if (targetField === undefined) {
      return {
        ok: false,
        error: { code: "invalid_mapping", message: `Target field "${targetId}" does not exist in the target.` },
      };
    }
    const existing = targetSuppliedBy.get(targetId);
    if (existing !== undefined) {
      return {
        ok: false,
        error: {
          code: "duplicate_target",
          message: `Target field "${targetId}" is mapped from both "${existing}" and "${sourceId}".`,
        },
      };
    }
    ownedTargets.set(sourceId, targetId);
    targetSuppliedBy.set(targetId, sourceId);
  }

  for (const targetId of Object.keys(input.defaults)) {
    if (targetFields.get(targetId) === undefined) {
      return {
        ok: false,
        error: { code: "invalid_default", message: `Default targets unknown field "${targetId}".` },
      };
    }
  }

  const values: Record<DefinitionId, unknown> = {};
  const warnings: string[] = [];
  const droppedSourceIds: string[] = [];
  const defaultedTargetIds: string[] = [];

  const sourceValueEntries = Object.entries(sourceState.values);

  for (const [sourceId, value] of sourceValueEntries) {
    const explicit = ownedTargets.get(sourceId);
    if (explicit !== undefined) {
      values[explicit] = structuredClone(value);
      continue;
    }
    const sameId = targetFields.get(sourceId);
    const sourceKind = sourceFields.get(sourceId)?.fieldKind;
    if (
      sameId !== undefined &&
      sourceKind !== undefined &&
      sameId.fieldKind !== "unknown" &&
      sourceKind !== "unknown" &&
      sameId.fieldKind === sourceKind
    ) {
      values[sourceId] = structuredClone(value);
      const sourceField = sourceFields.get(sourceId)!;
      if (!constraintsEqual(sourceField.constraints, sameId.constraints)) {
        warnings.push(`Constraints for field "${sourceId}" changed between source and target.`);
      }
      continue;
    }
    droppedSourceIds.push(sourceId);
  }

  for (const targetId of targetFields.keys()) {
    if (Object.hasOwn(values, targetId)) continue;
    if (Object.hasOwn(input.defaults, targetId)) {
      values[targetId] = structuredClone(input.defaults[targetId]);
      continue;
    }
    defaultedTargetIds.push(targetId);
  }

  if (droppedSourceIds.length > 0) {
    warnings.push(`Source field(s) ${droppedSourceIds.map((id) => `"${id}"`).join(", ")} have no target and will be dropped.`);
  }
  if (defaultedTargetIds.length > 0) {
    warnings.push(`Target field(s) ${defaultedTargetIds.map((id) => `"${id}"`).join(", ")} have no source value and will use their package default.`);
  }

  return { ok: true, values, warnings };
}

/**
 * I7 Phase 3 attached-migration seam (D1). The public
 * `Characters.previewMigration/commitMigration` entry points keep denying
 * attached scope at HTTP (`denyAttachedMigrationScope` above stays); the
 * `Campaigns` upgrade commands drive attached characters through the factory
 * below on the caller's transaction client. Both variants run the exact
 * existing preview/commit logic minus the attached-scope denial
 * (ownership/authorization is already established by the Campaigns caller:
 * active membership, GM role, campaign custody of the character) and never
 * issue `COMMIT` themselves.
 *
 * Query threading: the character persistence repository is pool-bound, so
 * this seam runs its own focused SQL on the passed client instead of
 * reaching through the pool (which would break the caller's atomicity).
 * The statements mirror the repository row shapes column-for-column.
 */

/** Minimal query surface shared by `Pool` and `PoolClient`. */
export type MigrationDbClient = Pick<PoolClient, "query">;

const MIGRATION_CHARACTER_COLUMNS =
  "id, owner_id, campaign_id, placement_generation, return_owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle, archived_at, created_at, updated_at";

type MigrationCharacterRow = {
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

function toMigrationCharacterRecord(row: MigrationCharacterRow): CharacterRecord {
  if (row.lifecycle !== "active" && row.lifecycle !== "archived") {
    throw new Error(`Unknown character lifecycle: ${row.lifecycle}`);
  }
  if (row.visibility !== "owner_only") {
    throw new Error(`Unknown character visibility: ${row.visibility}`);
  }
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
    visibility: row.visibility as "owner_only",
    lifecycle: row.lifecycle as CharacterLifecycle,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Runtime-error taxonomy shared by the standalone and attached migration
 * paths (moved here from the Characters module so both paths map
 * identically). Unrecognized/transient runtime codes (including the
 * runtime's `internal`, which SystemRuntime uses for temporary I/O failures
 * such as package-load errors) become temporarily_unavailable, not
 * programmer-error internals.
 */
export function mapMigrationRuntimeError(error: {
  code: string;
  message: string;
  definitionId?: string;
}): CharacterError {
  switch (error.code) {
    case "not_found":
      return { code: "not_found", message: "The published version or entity definition does not exist." };
    case "bad_request":
    case "invalid_state":
    case "unsupported_field_value":
    case "budget_exceeded":
    case "invalid_package":
      return { code: "invalid_value", message: error.message };
    default:
      return { code: "temporarily_unavailable", message: "A temporary infrastructure failure occurred." };
  }
}

// Only these runtime error codes are stable/deterministic for the same input
// and safe to permanently finalize on the idempotency key (standalone path).
const STABLE_MIGRATION_RUNTIME_ERROR_CODES = new Set([
  "not_found",
  "bad_request",
  "invalid_state",
  "unsupported_field_value",
  "budget_exceeded",
  "invalid_package",
]);

export function isFinalizableMigrationRuntimeError(code: string): boolean {
  return STABLE_MIGRATION_RUNTIME_ERROR_CODES.has(code);
}

// Mirrors of the Characters-module migration constants so the attached path
// honors the same windows without importing module-private values.
const ATTACHED_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const ATTACHED_ROLLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTACHED_NOT_FOUND_MESSAGE = "The requested character does not exist.";
const ATTACHED_ARCHIVED_MESSAGE = "Archived characters reject play commands until recovered.";

function attachedNotFound(): CharacterError {
  return { code: "not_found", message: ATTACHED_NOT_FOUND_MESSAGE };
}

function attachedConflict(latestRevision: number, message: string): CharacterError {
  return { code: "conflict", message, latestRevision };
}

export type AttachedMigrationDeps = {
  runtime: SystemRuntime;
  authorizeVersionUse: SystemAuthoring["authorizeVersionUse"];
  now?: () => Date;
  newId?: () => string;
};

/**
 * Non-persisting migration candidate: the exact preview computation
 * (version authorization, same-system check, source/target resolution,
 * candidate build, candidate validation) with no row writes. Shared by the
 * standalone preview, the persisting attached preview, and the read-only
 * campaign upgrade preview (which must write nothing).
 */
export type MigrationCandidate = {
  sourceRevision: number;
  sourceVersionId: string;
  sourceChecksum: string;
  targetVersionId: string;
  targetChecksum: string;
  candidateState: RuntimeStateV1;
  candidateProjection: CharacterProjectionV1;
  warnings: string[];
};

export async function buildMigrationCandidate(
  deps: Pick<AttachedMigrationDeps, "runtime" | "authorizeVersionUse"> & {
    loadVersionIdentity: (versionId: string) => Promise<{ systemId: string; checksum: string } | null>;
  },
  ctx: RequestContext,
  input: {
    character: Pick<CharacterRecord, "characterId" | "systemVersionId" | "entityDefinitionId" | "revision" | "state">;
    targetVersionId: string;
    mappings?: Record<DefinitionId, DefinitionId> | undefined;
    defaults?: Record<DefinitionId, unknown> | undefined;
  },
): Promise<CharacterResult<MigrationCandidate>> {
  const character = input.character;
  // Known-version use predicate, identical to standalone creation/migration:
  // owner or public/link access on an active system with a published target.
  const authorized = await deps.authorizeVersionUse(ctx, input.targetVersionId);
  if (!authorized.ok) return { ok: false, error: { code: "not_found", message: ATTACHED_NOT_FOUND_MESSAGE } };

  const sourceIdentity = await deps.loadVersionIdentity(character.systemVersionId);
  if (sourceIdentity === null) {
    return { ok: false, error: { code: "not_found", message: ATTACHED_NOT_FOUND_MESSAGE } };
  }
  if (sourceIdentity.systemId !== authorized.value.systemId) {
    return {
      ok: false,
      error: {
        code: "invalid_value",
        message: "The target version does not belong to the same system as the character.",
      },
    };
  }

  const sourceResolved = await deps.runtime.resolve({
    versionId: character.systemVersionId,
    entityId: character.entityDefinitionId,
    state: character.state,
    intent: { kind: "observe" },
  });
  if (!sourceResolved.ok) return { ok: false, error: mapMigrationRuntimeError(sourceResolved.error) };

  const targetSeed = await deps.runtime.resolve({
    versionId: authorized.value.versionId,
    entityId: character.entityDefinitionId,
    intent: { kind: "initialize" },
  });
  if (!targetSeed.ok) return { ok: false, error: mapMigrationRuntimeError(targetSeed.error) };

  const sourceFields = collectEditableFields(sourceResolved.value.projection, Object.keys(character.state.values));
  const targetFields = collectEditableFields(targetSeed.value.projection, Object.keys(targetSeed.value.state.values));

  const built = buildCandidateValues({
    sourceState: character.state,
    sourceFields,
    targetFields,
    mappings: input.mappings ?? {},
    defaults: input.defaults ?? {},
  });
  if (!built.ok) return { ok: false, error: { code: "invalid_value", message: built.error.message } };

  const candidate = await deps.runtime.resolve({
    versionId: authorized.value.versionId,
    entityId: character.entityDefinitionId,
    intent: { kind: "initialize", values: built.values },
  });
  if (!candidate.ok) return { ok: false, error: mapMigrationRuntimeError(candidate.error) };

  return {
    ok: true,
    value: {
      sourceRevision: character.revision,
      sourceVersionId: character.systemVersionId,
      sourceChecksum: sourceIdentity.checksum,
      targetVersionId: authorized.value.versionId,
      targetChecksum: authorized.value.checksum,
      candidateState: candidate.value.state,
      candidateProjection: candidate.value.projection,
      warnings: built.warnings,
    },
  };
}

export type AttachedMigrationCommands = {
  /**
   * Non-persisting candidate build for one attached character. Read-only:
   * no preview rows, no audit rows. The campaign upgrade preview calls
   * this per attached character.
   */
  buildAttachedMigrationCandidate(
    client: PoolClient,
    ctx: RequestContext,
    input: PreviewCharacterMigration,
  ): Promise<CharacterResult<MigrationCandidate>>;
  /**
   * Persisting attached preview (same computation plus a preview row and
   * audit row on the caller's client). Feeds the in-transaction upgrade
   * commit path; never wired to HTTP.
   */
  previewAttachedMigration(
    client: PoolClient,
    ctx: RequestContext,
    input: PreviewCharacterMigration,
  ): Promise<CharacterResult<CharacterMigrationPreview>>;
  /**
   * Attached commit for a previously built (in-transaction) preview. Same
   * checks and mutation as the standalone commit minus the attached-scope
   * denial and minus the standalone idempotency executions (idempotency is
   * owned by the campaign-level key). Never wired to HTTP.
   */
  commitAttachedMigration(
    client: PoolClient,
    ctx: RequestContext,
    input: CommitCharacterMigration,
  ): Promise<CharacterResult<CharacterCommandResult>>;
};

/**
 * Codebase `create*Module`-style factory capturing the runtime, the
 * known-version use predicate, and clock/ID overrides. The returned
 * functions run on the caller's `PoolClient` and never `COMMIT`.
 */
export function createAttachedMigrationCommands(deps: AttachedMigrationDeps): AttachedMigrationCommands {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  async function loadAttachedCharacter(
    client: MigrationDbClient,
    characterId: string,
  ): Promise<CharacterResult<CharacterRecord>> {
    const result = await client.query<MigrationCharacterRow>(
      `SELECT ${MIGRATION_CHARACTER_COLUMNS} FROM characters WHERE id = $1`,
      [characterId],
    );
    const row = result.rows[0];
    if (row === undefined) return { ok: false, error: attachedNotFound() };
    // Fail closed against standalone rows: a campaign-driven migration must
    // never repin a standalone sheet. Custody within the right campaign is
    // established by the Campaigns caller (which lists attached rows itself).
    if (row.campaign_id === null) return { ok: false, error: attachedNotFound() };
    try {
      return { ok: true, value: toMigrationCharacterRecord(row) };
    } catch {
      return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
    }
  }

  async function loadVersionIdentity(
    client: MigrationDbClient,
    versionId: string,
  ): Promise<{ systemId: string; checksum: string } | null> {
    const result = await client.query<{ system_id: string; checksum: string }>(
      `SELECT system_id, checksum FROM system_versions WHERE id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { systemId: row.system_id, checksum: row.checksum };
  }

  return {
    async buildAttachedMigrationCandidate(client, ctx, input) {
      try {
        const loaded = await loadAttachedCharacter(client, input.characterId);
        if (!loaded.ok) return loaded;
        return await buildMigrationCandidate(
          { runtime: deps.runtime, authorizeVersionUse: deps.authorizeVersionUse, loadVersionIdentity: (id) => loadVersionIdentity(client, id) },
          ctx,
          {
            character: loaded.value,
            targetVersionId: input.targetVersionId,
            mappings: input.mappings,
            defaults: input.defaults,
          },
        );
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },

    async previewAttachedMigration(client, ctx, input) {
      try {
        const loaded = await loadAttachedCharacter(client, input.characterId);
        if (!loaded.ok) return loaded;
        const character = loaded.value;
        const built = await buildMigrationCandidate(
          { runtime: deps.runtime, authorizeVersionUse: deps.authorizeVersionUse, loadVersionIdentity: (id) => loadVersionIdentity(client, id) },
          ctx,
          { character, targetVersionId: input.targetVersionId, mappings: input.mappings, defaults: input.defaults },
        );
        if (!built.ok) return built;
        const candidate = built.value;

        // Attached rows carry NULL owner_id while the preview table requires
        // a non-null owner: record the acting GM, who established custody.
        const previewOwnerId = ctx.actorId;
        const previewId = newId();
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + ATTACHED_PREVIEW_TTL_MS);
        const previewChecksum = hashInput({
          characterId: character.characterId,
          sourceRevision: candidate.sourceRevision,
          sourceVersionId: candidate.sourceVersionId,
          sourceChecksum: candidate.sourceChecksum,
          targetVersionId: candidate.targetVersionId,
          targetChecksum: candidate.targetChecksum,
          mappings: input.mappings ?? {},
          defaults: input.defaults ?? {},
          candidateState: candidate.candidateState,
          candidateProjection: candidate.candidateProjection,
          warnings: candidate.warnings,
          owner: previewOwnerId,
          expiresAt: expiresAt.toISOString(),
        });

        await client.query(
          `INSERT INTO character_migration_previews
             (id, character_id, owner_id, source_revision, source_version_id, source_checksum,
              target_version_id, target_checksum, mapping_json, candidate_state_json,
              candidate_projection_json, warnings_json, preview_checksum, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)`,
          [
            previewId,
            character.characterId,
            previewOwnerId,
            candidate.sourceRevision,
            candidate.sourceVersionId,
            candidate.sourceChecksum,
            candidate.targetVersionId,
            candidate.targetChecksum,
            JSON.stringify({ mappings: input.mappings ?? {}, defaults: input.defaults ?? {} }),
            JSON.stringify(candidate.candidateState),
            JSON.stringify(candidate.candidateProjection),
            JSON.stringify(candidate.warnings),
            previewChecksum,
            expiresAt,
          ],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [character.characterId, ctx.actorId, "character_migration_previewed", "Character migration preview built", ctx.requestId],
        );

        return {
          ok: true,
          value: {
            previewId,
            characterId: character.characterId,
            sourceRevision: candidate.sourceRevision,
            sourceVersionId: candidate.sourceVersionId,
            targetVersionId: candidate.targetVersionId,
            candidateState: candidate.candidateState,
            candidateProjection: candidate.candidateProjection,
            warnings: candidate.warnings,
            expiresAt: expiresAt.toISOString(),
          },
        };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },

    async commitAttachedMigration(client, ctx, input) {
      try {
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
          return { ok: false, error: { code: "bad_request", message: "expectedRevision must be a positive integer." } };
        }
        const claimStartedAt = now();

        // No attached-scope denial here by design (D1): custody was
        // established by the Campaigns caller. Standalone rows still fail
        // closed below via the attached-only character load.
        const previewResult = await client.query<{
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
          expires_at: Date;
          consumed_at: Date | null;
        }>(
          `SELECT id, character_id, owner_id, source_revision, source_version_id, source_checksum,
                  target_version_id, target_checksum, mapping_json, candidate_state_json,
                  candidate_projection_json, warnings_json, preview_checksum, expires_at, consumed_at
             FROM character_migration_previews WHERE id = $1 FOR UPDATE`,
          [input.previewId],
        );
        const preview = previewResult.rows[0];
        if (preview === undefined || preview.character_id !== input.characterId || preview.owner_id !== ctx.actorId) {
          return { ok: false, error: attachedNotFound() };
        }

        const charResult = await client.query<MigrationCharacterRow>(
          `SELECT ${MIGRATION_CHARACTER_COLUMNS} FROM characters WHERE id = $1 FOR UPDATE`,
          [input.characterId],
        );
        const charRow = charResult.rows[0];
        if (charRow === undefined || charRow.campaign_id === null) {
          return { ok: false, error: attachedNotFound() };
        }
        let character: CharacterRecord;
        try {
          character = toMigrationCharacterRecord(charRow);
        } catch {
          return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
        }
        if (character.lifecycle === "archived") {
          return { ok: false, error: { code: "conflict", message: ATTACHED_ARCHIVED_MESSAGE } };
        }
        if (preview.source_revision !== character.revision) {
          return { ok: false, error: attachedConflict(character.revision, "The character has a newer revision. Retry with the latest revision and a new idempotency key.") };
        }
        if (preview.consumed_at !== null) {
          return { ok: false, error: attachedConflict(character.revision, "The character has a newer revision. Retry with the latest revision and a new idempotency key.") };
        }
        if (new Date(preview.expires_at).getTime() <= claimStartedAt.getTime()) {
          return { ok: false, error: attachedConflict(character.revision, "The character has a newer revision. Retry with the latest revision and a new idempotency key.") };
        }

        const observed = await deps.runtime.resolve({
          versionId: preview.target_version_id,
          entityId: character.entityDefinitionId,
          state: preview.candidate_state_json as RuntimeStateV1,
          intent: { kind: "observe" },
        });
        if (!observed.ok) return { ok: false, error: mapMigrationRuntimeError(observed.error) };

        const targetIdentity = await loadVersionIdentity(client, preview.target_version_id);
        if (targetIdentity === null) return { ok: false, error: attachedNotFound() };

        // Recompute the preview checksum over the stored bound fields exactly
        // as the preview did; tampered bindings fail instead of committing.
        const storedMappings = preview.mapping_json as {
          mappings: Record<DefinitionId, DefinitionId>;
          defaults: Record<DefinitionId, unknown>;
        };
        const recomputedChecksum = hashInput({
          characterId: preview.character_id,
          sourceRevision: preview.source_revision,
          sourceVersionId: preview.source_version_id,
          sourceChecksum: preview.source_checksum,
          targetVersionId: preview.target_version_id,
          targetChecksum: preview.target_checksum,
          mappings: storedMappings.mappings,
          defaults: storedMappings.defaults,
          candidateState: preview.candidate_state_json,
          candidateProjection: preview.candidate_projection_json,
          warnings: preview.warnings_json,
          owner: preview.owner_id,
          expiresAt: new Date(preview.expires_at).toISOString(),
        });
        if (recomputedChecksum !== preview.preview_checksum) {
          return { ok: false, error: attachedConflict(character.revision, "The character has a newer revision. Retry with the latest revision and a new idempotency key.") };
        }

        if (
          charRow.revision !== input.expectedRevision
          || charRow.revision !== preview.source_revision
          || charRow.system_version_id !== preview.source_version_id
        ) {
          return { ok: false, error: attachedConflict(character.revision, "The character has a newer revision. Retry with the latest revision and a new idempotency key.") };
        }

        const updated = await client.query<MigrationCharacterRow>(
          `UPDATE characters
              SET system_version_id = $1::uuid, state_json = $2::jsonb, revision = revision + 1, updated_at = now()
            WHERE id = $3
            RETURNING ${MIGRATION_CHARACTER_COLUMNS}`,
          [preview.target_version_id, JSON.stringify(preview.candidate_state_json), input.characterId],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
        }

        const migrationId = newId();
        const rollbackDeadline = new Date(claimStartedAt.getTime() + ATTACHED_ROLLBACK_TTL_MS);
        await client.query(`UPDATE character_migration_previews SET consumed_at = now() WHERE id = $1`, [
          input.previewId,
        ]);
        await client.query(
          `INSERT INTO character_migrations
             (id, character_id, preview_id, source_version_id, target_version_id, before_state_json,
              after_state_json, commit_revision, rollback_deadline, actor_id, request_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
          [
            migrationId,
            input.characterId,
            input.previewId,
            preview.source_version_id,
            preview.target_version_id,
            JSON.stringify(character.state),
            JSON.stringify(preview.candidate_state_json),
            updatedRow.revision,
            rollbackDeadline,
            ctx.actorId,
            ctx.requestId,
          ],
        );
        await client.query(
          `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            updatedRow.id,
            updatedRow.revision,
            "character_migration_committed",
            JSON.stringify({ previewId: input.previewId, targetVersionId: preview.target_version_id }),
            ctx.requestId,
          ],
        );
        await client.query(
          `INSERT INTO character_audit_records (character_id, actor_id, kind, summary, request_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [updatedRow.id, ctx.actorId, "character_migration_committed", "Character migration committed", ctx.requestId],
        );

        const updatedRecord = toMigrationCharacterRecord(updatedRow);
        const view: CharacterView = {
          characterId: updatedRecord.characterId,
          ownerId: updatedRecord.ownerId,
          campaignId: updatedRecord.campaignId,
          controllers: [],
          placementGeneration: updatedRecord.placementGeneration,
          returnOwnerId: updatedRecord.returnOwnerId,
          name: updatedRecord.name,
          systemVersionId: updatedRecord.systemVersionId,
          entityDefinitionId: updatedRecord.entityDefinitionId,
          revision: updatedRecord.revision,
          lifecycle: updatedRecord.lifecycle,
          archivedAt: updatedRecord.archivedAt,
          createdAt: updatedRecord.createdAt,
          updatedAt: updatedRecord.updatedAt,
          state: updatedRecord.state,
          derivedValues: observed.value.derivedValues,
          validations: observed.value.validations,
          projection: observed.value.projection,
          reconciliation: {
            characterId: updatedRecord.characterId,
            baseRevision: input.expectedRevision,
            revision: updatedRecord.revision,
            packageChecksum: observed.value.packageChecksum,
            projectionVersion: "1.0",
            commandExecutionId: migrationId,
            replayExpiresAt: rollbackDeadline.toISOString(),
            replayed: false,
            changedDefinitionIds: [],
            activityCursor: null,
            cacheDisposition: "retain",
          },
        };
        return { ok: true, value: { character: view, roll: null } };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },
  };
}
