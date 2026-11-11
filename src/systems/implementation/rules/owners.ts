import type { SystemDocumentV1, ValidationV1 } from "../package/schema/index.js";

type OwnershipRules = Pick<SystemDocumentV1, "entities" | "sheets">;

export function sheetActionOwners(rules: OwnershipRules): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const sheet of rules.sheets) {
    for (const section of sheet.sections) {
      for (const element of section.elements) {
        if (element.kind !== "action") continue;
        const targets = owners.get(element.actionId) ?? new Set<string>();
        targets.add(sheet.targetEntityId);
        owners.set(element.actionId, targets);
      }
    }
  }
  return owners;
}

export function validationOwner(
  rules: OwnershipRules,
  validation: ValidationV1,
  actionOwners: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  const targets = actionOwners.get(validation.targetId);
  const candidates = rules.entities.filter(entity =>
    (validation.targetEntityId === undefined || validation.targetEntityId === entity.id)
    && (validation.targetId === entity.id
      || entity.fields.some(field => field.id === validation.targetId)
      || targets?.has(entity.id)),
  );
  return candidates.length === 1 ? candidates[0]!.id : undefined;
}
