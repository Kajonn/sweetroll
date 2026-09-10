import type {
  CharacterProjectionV1,
  CharacterProjectionElement,
  DefinitionId,
  RuntimeStateV1,
} from "../systems/runtime.js";

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
