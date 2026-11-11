import type { RuntimeStateV1 } from "../../runtime.js";
import type { EntityDefinitionV1, SystemPackageV1 } from "../package/schema/index.js";
import type { AggregateEntry } from "../rules/data.js";
import type { EvaluationBindings } from "../rules/evaluate.js";
import { effectiveEntryDefinition } from "./effective-entry.js";
import { buildFieldBindings } from "./state.js";

export function characterRuleBindings(
  pkg: SystemPackageV1,
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
): EvaluationBindings {
  let slots: Map<string, AggregateEntry[]> | undefined;
  return {
    fields: buildFieldBindings(entity, state),
    inputs: {},
    datasets: pkg.referenceData,
    slotEntries: (id) => {
      if (slots === undefined) {
        slots = new Map();
        for (const entry of Object.values(state.entries)) {
          const template = effectiveEntryDefinition(pkg, entry);
          const slot = slots.get(entry.slotId) ?? [];
          slot.push({
            values: template === undefined ? {} : entry.values,
            quantity: entry.quantity ?? 1,
            quantityFields: new Set(template?.quantityFields ?? []),
          });
          slots.set(entry.slotId, slot);
        }
      }
      return slots.get(id) ?? [];
    },
  };
}
