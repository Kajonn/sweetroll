import type { ObjectTemplateV1, SystemDocumentV1 } from "../package/schema/index.js";
import { DEFAULT_SLOT_MAX_ENTRIES } from "../runtime/entries.js";
import type { SlotEnvironment } from "./data.js";

type SlotRules = Pick<SystemDocumentV1, "sheets" | "slots" | "templates">;

export function slotEnvironment(
  rules: SlotRules,
  entityId: string,
  templates: readonly ObjectTemplateV1[] = rules.templates,
): SlotEnvironment {
  const ids = new Set(rules.sheets.filter(sheet => sheet.targetEntityId === entityId)
    .flatMap(sheet => sheet.sections.flatMap(section => section.elements.flatMap(element =>
      element.kind === "slot" ? [element.slotId] : [],
    ))));
  return Object.fromEntries(rules.slots.filter(slot => ids.has(slot.id)).map(slot => {
    const fields: Record<string, "number" | "boolean" | "unsupported" | "mixed"> = Object.create(null);
    for (const template of templates) {
      if (!slot.accepts.includes(template.kind)) continue;
      for (const field of template.fields) {
        const type = field.kind === "integer" || field.kind === "decimal" ? "number"
          : field.kind === "boolean" ? "boolean"
            : field.kind === "computed" && (field.valueType === "number" || field.valueType === "boolean") ? field.valueType : "unsupported";
        const previous = fields[field.id];
        fields[field.id] = previous === undefined || previous === type ? type : "mixed";
      }
    }
    return [slot.id, { capacity: slot.maxEntries ?? DEFAULT_SLOT_MAX_ENTRIES, fields }];
  }));
}

type CostRules = Pick<SystemDocumentV1, "slots" | "templates">;

/**
 * Worst-case cost of reading one computed template field through an aggregate
 * on a slot: the field's expression and every computed field it depends on,
 * for the most expensive template the slot accepts. Stored fields cost nothing.
 */
export function computedAggregateCost(
  rules: CostRules,
  expressions: ReadonlyMap<string, { cost: number; dependencies: readonly string[] }>,
): (slot: string, field: string) => number {
  const known = new Map<string, number>();
  const costIn = (template: ObjectTemplateV1, fieldId: string, seen: Set<string>): number => {
    const field = template.fields.find(candidate => candidate.id === fieldId);
    if (field?.kind !== "computed" || seen.has(fieldId)) return 0;
    seen.add(fieldId);
    const expression = expressions.get(field.expressionId);
    return expression === undefined ? 0
      : expression.dependencies.reduce((cost, dependency) => cost + costIn(template, dependency, seen), expression.cost);
  };
  return (slotId, fieldId) => {
    const key = `${slotId}:${fieldId}`;
    let cost = known.get(key);
    if (cost === undefined) {
      const slot = rules.slots.find(candidate => candidate.id === slotId);
      cost = slot === undefined ? 0 : Math.max(0, ...rules.templates
        .filter(template => slot.accepts.includes(template.kind))
        .map(template => costIn(template, fieldId, new Set())));
      known.set(key, cost);
    }
    return cost;
  };
}
