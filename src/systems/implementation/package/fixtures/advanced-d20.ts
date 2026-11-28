import type { FieldV1, SystemDocumentV1 } from "../schema/index.js";
import { d20Document } from "./d20.js";

function integer(id: string, label: string, value: number, min: number, max: number): FieldV1 {
  return { kind: "integer", id, label, default: value, min, max, step: 1, required: false };
}

/** Original d20 equipment and advancement rules used by the M2 acceptance journeys. */
export function advancedD20Document(): SystemDocumentV1 {
  const doc = structuredClone(d20Document);
  doc.metadata.name = "Roadwardens";
  const hero = doc.entities[0]!;
  hero.fields.push(
    integer("level", "Level", 1, 1, 10),
    integer("armor", "Training armor", 1, 0, 10),
    { kind: "computed", id: "carried", label: "Carried weight", valueType: "number", expressionId: "carried_expr" },
    { kind: "computed", id: "proficiency_bonus", label: "Proficiency bonus", valueType: "number", expressionId: "proficiency_expr" },
    { kind: "singleChoice", id: "rank", label: "Rank", required: false, default: "rookie", options: [], optionsFrom: "advancement" },
  );
  const health = hero.fields.find(field => field.kind === "resource" && field.id === "health");
  if (health?.kind !== "resource") throw Error("Missing health");
  health.maxExpressionId = "health_max";
  doc.validations[0]!.targetEntityId = hero.id;
  doc.referenceData.push({
    id: "advancement", label: "Advancement", keyColumn: "level", columns: { level: "number", bonus: "number", health: "number" },
    records: [
      { id: "rookie", label: "Rookie", values: { level: 1, bonus: 2, health: 10 } },
      { id: "veteran", label: "Veteran", values: { level: 4, bonus: 3, health: 18 } },
    ],
  });
  doc.slots.push({ id: "equipment", label: "Equipment", accepts: ["item"], maxEntries: 20 });
  doc.templates.push({
    id: "leather", kind: "item", label: "Leather armor", quantityFields: ["weight"],
    fields: [
      integer("armor", "Armor bonus", 2, 0, 10),
      integer("weight", "Weight", 3, 0, 100),
      { kind: "boolean", id: "equipped", label: "Equipped", required: false, default: true },
    ],
    grantedActions: [{ id: "inspect_armor", kind: "roll", label: "Inspect armor", expressionId: "inspect_expr", inputs: [], outputTemplate: "Armor check: {total}" }],
  });
  const combat = doc.sheets[0]!.sections.at(-1)!;
  combat.elements.push(
    { kind: "slot", id: "equipment_section", slotId: "equipment" },
    { kind: "field", id: "carried_value", fieldId: "carried" },
    { kind: "field", id: "proficiency_bonus_value", fieldId: "proficiency_bonus" },
    { kind: "field", id: "level_value", fieldId: "level" },
    { kind: "field", id: "rank_value", fieldId: "rank" },
  );
  doc.expressions.find(expression => expression.id === "defense_expr")!.source =
    '10 + fields.modifier + sumWhere("equipment", "armor", "equipped")';
  doc.expressions.push(
    { id: "carried_expr", context: "computed", resultType: "number", fallback: 0, source: 'sum("equipment", "weight")' },
    { id: "proficiency_expr", context: "computed", resultType: "number", fallback: 2, source: 'lookupBand("advancement", fields.level, "bonus")' },
    { id: "health_max", context: "computed", resultType: "number", fallback: 10, source: 'lookupBand("advancement", fields.level, "health")' },
    { id: "inspect_expr", context: "roll", resultType: "number", fallback: 0, source: "d1 + fields.armor + item.armor" },
  );
  return doc;
}
