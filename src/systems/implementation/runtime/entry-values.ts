import type { CharacterEntryV1, ObjectTemplateV1, SystemPackageV1 } from "../package/schema/index.js";
import { evaluate, type EvaluationBindings } from "../rules/evaluate.js";

type ItemBindings = EvaluationBindings["fields"];

/**
 * The `item.` scope of one entry: its stored values (template defaults where
 * unset) and a `derive` function that evaluates a computed template field on
 * demand. Computed fields read only the entry and reference data, so the
 * result depends on nothing but the entry and the pinned package.
 */
export function entryItemScope(
  pkg: SystemPackageV1,
  template: ObjectTemplateV1,
  entry: CharacterEntryV1,
): { item: ItemBindings; derive: (fieldId: string) => boolean; computedIds: string[] } {
  const item: ItemBindings = {};
  const computed = new Map(template.fields.flatMap(field =>
    field.kind === "computed" ? [[field.id, field.expressionId] as const] : [],
  ));
  for (const field of template.fields) {
    if (field.kind === "computed" || field.kind === "image") continue;
    const value = Object.hasOwn(entry.values, field.id) ? entry.values[field.id] : field.default;
    if (field.kind === "resource" && isResourceValue(value)) {
      item[field.id] = value.current;
      item[`${field.id}.current`] = value.current;
      item[`${field.id}.max`] = value.max;
    } else {
      item[field.id] = value as ItemBindings[string];
    }
  }
  const visiting = new Set<string>();
  const derive = (id: string): boolean => {
    const expressionId = computed.get(id);
    if (expressionId === undefined || Object.hasOwn(item, id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const expression = pkg.expressions.find(candidate => candidate.id === expressionId);
    if (!expression || !expression.dependencies.every(derive)) return false;
    const result = evaluate(expression, { fields: {}, inputs: {}, item, datasets: pkg.referenceData });
    if (!result.ok) return false;
    item[id] = result.result;
    visiting.delete(id);
    return true;
  };
  return { item, derive, computedIds: [...computed.keys()] };
}

export function isResourceValue(value: unknown): value is { current: number; max: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { current, max } = value as { current: unknown; max: unknown };
  return typeof current === "number" && typeof max === "number"
    && Number.isFinite(current) && Number.isFinite(max);
}
