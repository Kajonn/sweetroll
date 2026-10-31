import { Value } from "@sinclair/typebox/value";
import { EntrySnapshotSchema } from "../package/schema/dynamic.js";
import type {
  CharacterEntryV1,
  EntityDefinitionV1,
  ObjectTemplateV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import { validEntryValue, validateEntryForSlot } from "./entries.js";

export function effectiveEntryDefinition(
  pkg: SystemPackageV1,
  entry: CharacterEntryV1,
): ObjectTemplateV1 | undefined {
  if (entry.templateId !== null)
    return (pkg.templates ?? []).find((t) => t.id === entry.templateId);
  const snapshot = entry.snapshot;
  if (
    entry.source?.kind !== "campaign" ||
    !snapshot ||
    !("base" in snapshot) ||
    !Value.Check(EntrySnapshotSchema, snapshot) ||
    snapshot.base.versionId !== pkg.versionId ||
    snapshot.base.packageChecksum !== pkg.integrity.checksum
  )
    return undefined;
  const template = (pkg.templates ?? []).find(
    (t) => t.id === snapshot.base.templateId,
  );
  if (
    !template ||
    template.kind !== snapshot.kind ||
    !validDefaults(template, snapshot.defaultValues)
  )
    return undefined;
  return template;
}
export function validDefaults(
  template: ObjectTemplateV1,
  values: Record<string, unknown>,
): boolean {
  return (
    Object.keys(values).length <= 100 &&
    Object.entries(values).every(([id, v]) => {
      const field = template.fields.find((f) => f.id === id);
      return field !== undefined && validEntryValue(field, v);
    })
  );
}
export function materializeDefaults(
  template: ObjectTemplateV1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    template.fields.flatMap((f) =>
      f.kind === "computed" || f.kind === "image"
        ? []
        : [
            [
              f.id,
              structuredClone(
                Object.hasOwn(overrides, f.id) ? overrides[f.id] : f.default,
              ),
            ],
          ],
    ),
  );
}
/** All inherited actions must be applicable; never omit an unsupported action. */
export function templateApplicable(
  pkg: SystemPackageV1,
  entity: EntityDefinitionV1,
  template: ObjectTemplateV1,
  slotId?: string,
): boolean {
  const sheetSlots = new Set(
    pkg.sheets
      .filter((s) => s.targetEntityId === entity.id)
      .flatMap((s) =>
        s.sections.flatMap((x) =>
          x.elements.flatMap((e) => (e.kind === "slot" ? [e.slotId] : [])),
        ),
      ),
  );
  if (
    !(pkg.slots ?? []).some(
      (s) =>
        sheetSlots.has(s.id) &&
        (!slotId || s.id === slotId) &&
        s.accepts.includes(template.kind),
    )
  )
    return false;
  const fields = new Set(
    [
      ...entity.fields,
      ...template.fields.filter(
        (f) => f.kind !== "computed" && f.kind !== "image",
      ),
    ].map((f) => f.id),
  );
  function refs(node: unknown): boolean {
    if (!node || typeof node !== "object") return true;
    const n = node as Record<string, unknown>;
    if (n.scope === "fields" && typeof n.id === "string" && !fields.has(n.id))
      return false;
    return Object.values(n).every((v) =>
      Array.isArray(v) ? v.every(refs) : refs(v),
    );
  }
  return template.grantedActions.every(
    (a) =>
      a.kind !== "roll" ||
      !!pkg.expressions.find((e) => e.id === a.expressionId && refs(e.ast)),
  );
}
export function derivedEntryError(
  pkg: SystemPackageV1,
  entity: EntityDefinitionV1,
  entry: CharacterEntryV1,
  siblings: number,
): string | null {
  if (
    entry.source?.kind === "campaign" &&
    (!entry.snapshot ||
      entry.templateId !== null ||
      !Value.Check(EntrySnapshotSchema, entry.snapshot))
  )
    return "Campaign entry snapshot is invalid.";
  if (!entry.snapshot || !("base" in entry.snapshot)) return null;
  const template = effectiveEntryDefinition(pkg, entry);
  if (
    entry.quantity !== undefined &&
    (!Number.isSafeInteger(entry.quantity) ||
      entry.quantity < 1 ||
      template?.kind !== "item")
  )
    return "Only derived items accept a positive safe integer quantity.";
  if (
    !template ||
    entry.templateId !== null ||
    !templateApplicable(pkg, entity, template, entry.slotId)
  )
    return "Derived entry source is invalid or incompatible with this character.";
  if (
    template.fields.some(
      (f) =>
        f.kind !== "computed" &&
        f.kind !== "image" &&
        !Object.hasOwn(entry.values, f.id),
    )
  )
    return "Derived entry is missing a typed value.";
  const valid = validateEntryForSlot(
    entry,
    pkg.slots ?? [],
    pkg.templates ?? [],
    siblings,
  );
  return valid.ok ? null : valid.message;
}
