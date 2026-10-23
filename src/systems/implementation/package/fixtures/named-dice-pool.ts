import { d6SuccessPoolDocument } from "./d6-success-pool.js";
import type { SystemDocumentV1 } from "../schema/document.js";

export const namedPoolSource =
  'countSuccesses(group("attribute", "Attribute", dice(fields.attribute + inputs.bonus_dice, 6)), 6) + 2 * countSuccesses(group("skill", "Skill", dice(fields.skill, 8)), 5) + group("gear", "Gear", dice(fields.gear, 4))';
/** License-neutral authoring fixture; never rewrites the legacy reference seed. */
export function namedDicePoolDocument(): SystemDocumentV1 {
  const doc = structuredClone(d6SuccessPoolDocument);
  doc.schemaVersion = "1.1";
  doc.metadata.name = "Named Dice Pool";
  doc.entities[0]!.fields.push({
    id: "gear",
    label: "Gear",
    kind: "integer",
    default: 0,
    required: true,
    min: 0,
    max: 10,
    step: 1,
  });
  doc.sheets[0]!.sections[0]!.elements.push({
    kind: "field",
    id: "gear_count",
    fieldId: "gear",
  });
  doc.expressions.find((e) => e.id === "pool_roll_expr")!.source =
    namedPoolSource;
  return doc;
}
