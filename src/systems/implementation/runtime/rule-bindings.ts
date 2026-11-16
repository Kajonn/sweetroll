import type { RuntimeStateV1 } from "../../runtime.js";
import type { CharacterEntryV1, EntityDefinitionV1, ObjectTemplateV1, SystemPackageV1 } from "../package/schema/index.js";
import type { AggregateEntry } from "../rules/data.js";
import type { EvaluationBindings } from "../rules/evaluate.js";
import { effectiveEntryDefinition } from "./effective-entry.js";
import { entryItemScope } from "./entry-values.js";
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
    dice: pkg.dice,
    datasets: pkg.referenceData,
    slotEntries: (id) => {
      if (slots === undefined) {
        slots = new Map();
        for (const entry of Object.values(state.entries)) {
          const template = effectiveEntryDefinition(pkg, entry);
          const slot = slots.get(entry.slotId) ?? [];
          slot.push({
            values: template === undefined ? {} : entry.values,
            ...(template === undefined ? {} : computedReader(pkg, template, entry)),
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

/** Evaluates a computed template field of one entry the first time an aggregate asks for it. */
function computedReader(pkg: SystemPackageV1, template: ObjectTemplateV1, entry: CharacterEntryV1): { computed?: (fieldId: string) => unknown } {
  if (!template.fields.some(field => field.kind === "computed")) return {};
  let scope: ReturnType<typeof entryItemScope> | undefined;
  return {
    computed: (fieldId) => {
      scope ??= entryItemScope(pkg, template, entry);
      return scope.computedIds.includes(fieldId) && scope.derive(fieldId) ? scope.item[fieldId] : undefined;
    },
  };
}
