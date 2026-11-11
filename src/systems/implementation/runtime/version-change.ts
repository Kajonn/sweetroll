import { isDeepStrictEqual } from "node:util";

import type { RuntimeStateV1, RuntimeValidation } from "../../runtime.js";
import { comparePackages, type CompatibilityFinding } from "../package/compatibility.js";
import type {
  CharacterEntryV1,
  FieldV1,
  ObjectTemplateV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import { derivedEntryError, slotsForEntity, templateApplicable, validDefaults } from "./effective-entry.js";
import { validateEntryForSlot } from "./entries.js";
import { resolveObservedValues } from "./resolve.js";
import { decodeRuntimeState, initializeState } from "./state.js";

/**
 * Design Section 6.7: moving a character between published versions of one
 * system. On `upgrade`, a breaking package finding blocks only when it touches
 * this character (owner decision 2026-11-07); `revert` (back to the recorded
 * previous version) skips the comparison because undoing additions always reads
 * as removals. Both directions then rebuild and verify
 * this character's state against the target package. Nothing is remapped:
 * values travel by stable definition ID.
 */
export type VersionChangeDirection = "upgrade" | "revert";

export type VersionChangeBlockerCode =
  | "same_version"
  | "different_system"
  | "breaking_change"
  | "unknown_entity"
  | "current_state_invalid"
  | "field_value_invalid"
  | "entry_template_missing"
  | "entry_invalid"
  | "evaluation_failed";

export type VersionChangeBlocker = {
  code: VersionChangeBlockerCode;
  message: string;
  definitionId?: string;
  entryId?: string;
};

export type EntryVersionChange = {
  entryId: string;
  templateId: string;
  /** Values that still matched the old template default and now follow the new one. */
  updatedFields: string[];
  /** Values the player changed; kept although the template default changed. */
  keptFields: string[];
  addedFields: string[];
  droppedFields: string[];
  imageUpdated: boolean;
};

export type VersionChangeFinding = CompatibilityFinding & { affectsCharacter: boolean };

export type VersionChangeReport = {
  ok: boolean;
  direction: VersionChangeDirection;
  fromVersionId: string;
  toVersionId: string;
  /** Breaking findings between the two packages; only affecting ones block. */
  packageFindings: VersionChangeFinding[];
  blockers: VersionChangeBlocker[];
  addedFields: string[];
  droppedFields: string[];
  changedEntries: EntryVersionChange[];
  validations: RuntimeValidation[];
  nextState: RuntimeStateV1 | null;
};

export function checkVersionChange(input: {
  from: SystemPackageV1;
  to: SystemPackageV1;
  entityId: string;
  state: unknown;
  direction: VersionChangeDirection;
}): VersionChangeReport {
  const { from, to, entityId, direction } = input;
  const report: VersionChangeReport = {
    ok: false,
    direction,
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    packageFindings: [],
    blockers: [],
    addedFields: [],
    droppedFields: [],
    changedEntries: [],
    validations: [],
    nextState: null,
  };
  const block = (blocker: VersionChangeBlocker): VersionChangeReport => {
    report.blockers.push(blocker);
    return report;
  };

  if (from.systemId !== to.systemId) {
    return block({ code: "different_system", message: "The target version belongs to a different system." });
  }
  if (from.versionId === to.versionId) {
    return block({ code: "same_version", message: "The character already uses this version." });
  }
  const fromEntity = from.entities.find((entity) => entity.id === entityId);
  const toEntity = to.entities.find((entity) => entity.id === entityId);
  if (fromEntity === undefined || toEntity === undefined) {
    return block({ code: "unknown_entity", message: "The character type does not exist in both versions.", definitionId: entityId });
  }
  const current = decodeRuntimeState(fromEntity, input.state);
  if (!current.ok) {
    return block({
      code: "current_state_invalid",
      message: current.error.message,
      ...(current.error.definitionId === undefined ? {} : { definitionId: current.error.definitionId }),
    });
  }
  if (direction === "upgrade") {
    const affects = characterFootprint(from, fromEntity.id, Object.values(current.value.entries));
    report.packageFindings = comparePackages(from, to).findings.map((finding) => ({
      ...finding,
      affectsCharacter: affects(finding.path),
    }));
    for (const finding of report.packageFindings) {
      if (finding.affectsCharacter) {
        report.blockers.push({ code: "breaking_change", message: finding.message, definitionId: finding.path });
      }
    }
  }

  // Character fields: keep by ID, default new fields, drop absent ones.
  const targetStored = new Set(toEntity.fields.filter((f) => f.kind !== "computed").map((f) => f.id));
  const kept: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(current.value.values)) {
    if (targetStored.has(id)) kept[id] = value;
    else report.droppedFields.push(id);
  }
  report.addedFields = [...targetStored].filter((id) => !Object.hasOwn(kept, id));
  for (const id of Object.keys(kept)) {
    const rebuilt = initializeState(toEntity, { [id]: kept[id] });
    if (!rebuilt.ok) {
      report.blockers.push({ code: "field_value_invalid", message: "This value is not valid in the target version.", definitionId: id });
    }
  }
  if (report.blockers.length > 0) return report;
  const values = initializeState(toEntity, kept);
  if (!values.ok) return block({ code: "field_value_invalid", message: values.error.message });

  // Entries: system and derived entries follow template defaults they never changed.
  const entries: Record<string, CharacterEntryV1> = {};
  for (const [key, stored] of Object.entries(current.value.entries).sort(([a], [b]) => a.localeCompare(b))) {
    const moved = moveEntry(stored, from, to);
    if ("blocker" in moved) {
      report.blockers.push({ ...moved.blocker, entryId: stored.entryId });
      continue;
    }
    if (moved.change !== null) report.changedEntries.push(moved.change);
    entries[key] = moved.entry;
  }
  if (report.blockers.length > 0) return report;

  const allowedSlots = slotsForEntity(to, toEntity.id);
  const allowedSlotIds = new Set(allowedSlots.map((slot) => slot.id));
  for (const entry of Object.values(entries)) {
    const siblings = Object.values(entries).filter((other) => other.slotId === entry.slotId && other.entryId !== entry.entryId).length;
    if (!allowedSlotIds.has(entry.slotId)) {
      report.blockers.push({ code: "entry_invalid", message: "The entry's slot is not on this character's sheet in the target version.", entryId: entry.entryId, definitionId: entry.slotId });
      continue;
    }
    const valid = validateEntryForSlot(entry, allowedSlots, to.templates, siblings);
    if (!valid.ok) {
      report.blockers.push({
        code: "entry_invalid",
        message: valid.message,
        entryId: entry.entryId,
        ...(valid.definitionId === undefined ? {} : { definitionId: valid.definitionId }),
      });
      continue;
    }
    const derived = derivedEntryError(to, toEntity, entry, siblings);
    if (derived !== null) report.blockers.push({ code: "entry_invalid", message: derived, entryId: entry.entryId });
  }
  if (report.blockers.length > 0) return report;

  const nextState = decodeRuntimeState(toEntity, { schemaVersion: "1.0", values: values.value.values, entries });
  if (!nextState.ok) return block({ code: "field_value_invalid", message: nextState.error.message });
  const observed = resolveObservedValues(to, toEntity, nextState.value);
  if (!observed.ok) return block({ code: "evaluation_failed", message: observed.error.message });

  report.validations = observed.value.validations;
  report.nextState = observed.value.state;
  report.ok = report.blockers.length === 0;
  if (!report.ok) report.nextState = null;
  return report;
}

/**
 * Which package paths this character depends on in its current version: its own
 * entity, the actions on its sheets, the templates and slots of its entries and
 * the expressions behind its computed fields and those actions. Findings
 * elsewhere (another entity, an unused item or slot, a removed validation) do
 * not touch it.
 */
function characterFootprint(
  pkg: SystemPackageV1,
  entityId: string,
  entries: CharacterEntryV1[],
): (path: string) => boolean {
  const entity = pkg.entities.find((candidate) => candidate.id === entityId)!;
  const templateIds = new Set(entries.flatMap((entry) => {
    const snapshot = entry.snapshot;
    const id = entry.templateId ?? (snapshot !== undefined && "base" in snapshot ? snapshot.base.templateId : null);
    return id === null ? [] : [id];
  }));
  const slotIds = new Set(entries.map((entry) => entry.slotId));
  const actionIds = new Set(pkg.sheets
    .filter((sheet) => sheet.targetEntityId === entityId)
    .flatMap((sheet) => sheet.sections.flatMap((section) =>
      section.elements.flatMap((element) => (element.kind === "action" ? [element.actionId] : [])))));
  const expressionIds = new Set<string>();
  for (const field of entity.fields) {
    if (field.kind === "computed") expressionIds.add(field.expressionId);
    if (field.kind === "resource" && field.maxExpressionId !== undefined) expressionIds.add(field.maxExpressionId);
  }
  for (const action of pkg.actions) if (actionIds.has(action.id) && action.kind === "roll") expressionIds.add(action.expressionId);
  for (const template of pkg.templates) {
    if (!templateIds.has(template.id)) continue;
    for (const action of template.grantedActions) if (action.kind === "roll") expressionIds.add(action.expressionId);
  }
  return (path) => {
    const [, kind, id] = path.split("/");
    switch (kind) {
      case "entities": return id === entityId;
      case "actions": return id !== undefined && actionIds.has(id);
      case "templates": return id !== undefined && templateIds.has(id);
      case "slots": return id !== undefined && slotIds.has(id);
      case "expressions": return id !== undefined && expressionIds.has(id);
      default: return false;
    }
  };
}

type MovedEntry =
  | { entry: CharacterEntryV1; change: EntryVersionChange | null }
  | { blocker: Omit<VersionChangeBlocker, "entryId"> };

function moveEntry(stored: CharacterEntryV1, from: SystemPackageV1, to: SystemPackageV1): MovedEntry {
  const entry = structuredClone(stored);
  const snapshot = entry.snapshot;
  const derivedBase = entry.source?.kind === "campaign" && snapshot !== undefined && "base" in snapshot ? snapshot.base : null;
  const templateId = entry.templateId ?? derivedBase?.templateId ?? null;
  // Personal and data-only campaign entries carry no rules references.
  if (templateId === null) return { entry, change: null };

  const fromTemplate = from.templates.find((t) => t.id === templateId);
  const toTemplate = to.templates.find((t) => t.id === templateId);
  if (toTemplate === undefined) {
    return { blocker: { code: "entry_template_missing", message: `Template "${templateId}" does not exist in the target version.`, definitionId: templateId } };
  }

  const change: EntryVersionChange = {
    entryId: entry.entryId,
    templateId,
    updatedFields: [],
    keptFields: [],
    addedFields: [],
    droppedFields: [],
    imageUpdated: false,
  };
  entry.values = followDefaults(entry.values, fromTemplate, toTemplate, change);

  if (derivedBase !== null && snapshot !== undefined && "base" in snapshot) {
    // Derived campaign entries pin their base to the exact package.
    snapshot.base = { versionId: to.versionId, packageChecksum: to.integrity.checksum, templateId };
    snapshot.defaultValues = followDefaults(snapshot.defaultValues, fromTemplate, toTemplate, null);
  }
  if (entry.templateId !== null && isDeepStrictEqual(entry.image, fromTemplate?.image)) {
    if (!isDeepStrictEqual(fromTemplate?.image, toTemplate.image)) change.imageUpdated = true;
    if (toTemplate.image === undefined) delete entry.image;
    else entry.image = structuredClone(toTemplate.image);
  }

  const changed = change.updatedFields.length + change.keptFields.length + change.addedFields.length
    + change.droppedFields.length > 0 || change.imageUpdated;
  return { entry, change: changed ? change : null };
}

function storedTemplateFields(template: ObjectTemplateV1 | undefined): Map<string, FieldV1> {
  return new Map((template?.fields ?? [])
    .filter((field) => field.kind !== "computed" && field.kind !== "image")
    .map((field) => [field.id, field]));
}

function fieldDefault(field: FieldV1 | undefined): unknown {
  return field === undefined || field.kind === "computed" || field.kind === "image" ? undefined : field.default;
}

/**
 * A value equal to the old template default was never changed by the player,
 * so it follows the new default. Changed values are kept. New template fields
 * receive their default; values of fields the target lacks are dropped.
 */
export function followDefaults(
  values: Record<string, unknown>,
  fromTemplate: ObjectTemplateV1 | undefined,
  toTemplate: ObjectTemplateV1,
  change: EntryVersionChange | null,
): Record<string, unknown> {
  const fromFields = storedTemplateFields(fromTemplate);
  const toFields = storedTemplateFields(toTemplate);
  const next: Record<string, unknown> = {};
  for (const id of Object.keys(values)) {
    if (!toFields.has(id)) change?.droppedFields.push(id);
  }
  for (const [id, toField] of toFields) {
    const newDefault = fieldDefault(toField);
    if (!Object.hasOwn(values, id)) {
      next[id] = structuredClone(newDefault);
      change?.addedFields.push(id);
      continue;
    }
    const value = values[id];
    const fromField = fromFields.get(id);
    const oldDefault = fieldDefault(fromField);
    const defaultChanged = fromField !== undefined && !isDeepStrictEqual(oldDefault, newDefault);
    if (defaultChanged && fromField.kind === toField.kind && isDeepStrictEqual(value, oldDefault)) {
      next[id] = structuredClone(newDefault);
      change?.updatedFields.push(id);
    } else {
      next[id] = structuredClone(value);
      if (defaultChanged) change?.keptFields.push(id);
    }
  }
  return next;
}

export type TemplateBaseChange = {
  ok: boolean;
  blockers: VersionChangeBlocker[];
  /** Rebased base pin and defaults; null when blocked. */
  next: { base: { versionId: string; packageChecksum: string; templateId: string }; defaultValues: Record<string, unknown> } | null;
};

/**
 * Design 6.7 campaign path: re-pin a campaign template's system base to the
 * target package. Defaults that still equal the old base default follow the
 * new one. On upgrade, a breaking finding on the base template blocks.
 */
export function checkTemplateBaseChange(input: {
  from: SystemPackageV1;
  to: SystemPackageV1;
  kind: string;
  base: { templateId: string };
  defaultValues: Record<string, unknown>;
  direction: VersionChangeDirection;
}): TemplateBaseChange {
  const { from, to, base } = input;
  const blockers: VersionChangeBlocker[] = [];
  if (input.direction === "upgrade") {
    for (const finding of comparePackages(from, to).findings) {
      const [, kind, id] = finding.path.split("/");
      if (kind === "templates" && id === base.templateId) {
        blockers.push({ code: "breaking_change", message: finding.message, definitionId: finding.path });
      }
    }
  }
  const fromTemplate = from.templates.find((t) => t.id === base.templateId);
  const toTemplate = to.templates.find((t) => t.id === base.templateId && t.kind === input.kind);
  if (toTemplate === undefined) {
    blockers.push({ code: "entry_template_missing", message: `Template "${base.templateId}" does not exist in the target version.`, definitionId: base.templateId });
    return { ok: false, blockers, next: null };
  }
  const defaultValues = followDefaults(input.defaultValues, fromTemplate, toTemplate, null);
  if (!validDefaults(toTemplate, defaultValues) || !to.entities.some((entity) => templateApplicable(to, entity, toTemplate))) {
    blockers.push({ code: "entry_invalid", message: `Template "${base.templateId}" cannot be used as a base in the target version.`, definitionId: base.templateId });
  }
  if (blockers.length > 0) return { ok: false, blockers, next: null };
  return {
    ok: true,
    blockers,
    next: {
      base: { versionId: to.versionId, packageChecksum: to.integrity.checksum, templateId: base.templateId },
      defaultValues,
    },
  };
}
