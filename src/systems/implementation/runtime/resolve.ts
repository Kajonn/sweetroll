import { dataObservationCost } from "../rules/data.js";
import { computedAggregateCost } from "../rules/slots.js";
import { sheetActionOwners, validationOwner } from "../rules/owners.js";
import { DEFAULT_SLOT_MAX_ENTRIES } from "./entries.js";
import { characterRuleBindings } from "./rule-bindings.js";
import { effectiveEntryDefinition } from "./effective-entry.js";
import { entryItemScope } from "./entry-values.js";
import { buildFieldBindings } from "./state.js";
import type {
  RuntimeResourceValue,
  RuntimeResult,
  RuntimeScalar,
  RuntimeStateV1,
  RuntimeValidation,
} from "../../runtime.js";
import type {
  EntityDefinitionV1,
  SystemPackageV1,
  ResourceFieldV1,
} from "../package/schema/index.js";
import { evaluate } from "../rules/evaluate.js";

export type ObservedRuntimeValues = {
  state: RuntimeStateV1;
  derivedValues: Record<string, RuntimeScalar>;
  validations: RuntimeValidation[];
};

export function resolveObservedValues(
  packageValue: SystemPackageV1,
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  /** Resources with a calculated maximum to fill on this observation (new characters). */
  options: { fill?: ReadonlySet<string> } = {},
): RuntimeResult<ObservedRuntimeValues> {
  const expressions = new Map(packageValue.expressions.map((expression) => [expression.id, expression]));
  const computedById = new Map<string, { expressionId: string; resource?: ResourceFieldV1 }>(entity.fields.flatMap(field => {
    if (field.kind === "computed") return [[field.id, { expressionId: field.expressionId }] as const];
    if (field.kind === "resource" && field.maxExpressionId !== undefined) {
      return [[field.id, { expressionId: field.maxExpressionId, resource: field }] as const];
    }
    return [];
  }));
  // Template resources with a calculated maximum (design 6.4, S11) are
  // normalized first, so aggregates and every later formula see the result.
  const normalized = normalizeEntryResources(packageValue, entity, state);
  if (!normalized.ok) return normalized;
  state = normalized.value;
  const bindings = characterRuleBindings(packageValue, entity, state);
  const capacities = new Map(packageValue.slots.map(slot => [slot.id, slot.maxEntries ?? DEFAULT_SLOT_MAX_ENTRIES]));
  const computedCost = computedAggregateCost(packageValue, expressions);
  let resolvedState = state;
  const derivedValues: Record<string, RuntimeScalar> = {};
  const validations: RuntimeValidation[] = entity.fields.flatMap((field) => {
    if (field.kind === "computed" || field.kind === "resource" || !field.required) return [];
    const value = state.values[field.id];
    const missing = value === null || value === "" || (Array.isArray(value) && value.length === 0);
    return missing
      ? [{
          validationId: `required_${field.id}`,
          severity: "error" as const,
          message: `${field.label} is required.`,
          targetDefinitionId: field.id,
        }]
      : [];
  });
  const complete = new Set<string>();
  const visiting = new Set<string>();
  let spent = 0;

  const evaluateComputed = (fieldId: string): RuntimeResult<null> => {
    if (complete.has(fieldId)) return { ok: true, value: null };
    const field = computedById.get(fieldId);
    if (field === undefined) return { ok: true, value: null };
    if (visiting.has(fieldId)) return invalidPackage(fieldId);
    visiting.add(fieldId);
    const expression = expressions.get(field.expressionId);
    if (expression === undefined) return invalidPackage(field.expressionId);
    for (const dependency of expression.dependencies) {
      const dependencyResult = evaluateComputed(dependency);
      if (!dependencyResult.ok) return dependencyResult;
    }
    spent += expression.cost + dataObservationCost(expression.ast, capacities, computedCost);
    if (spent > packageValue.effectiveLimits.sheetEvaluationNodes) return budgetExceeded();
    const result = evaluate(expression, bindings);
    if (!result.ok) return invalidPackage(expression.id);
    if (field.resource !== undefined) {
      if (typeof result.result !== "number" || !Number.isFinite(result.result)) return invalidPackage(expression.id);
      const stored = resolvedState.values[fieldId] as RuntimeResourceValue;
      const max = boundedMaximum(field.resource, result.result);
      // startFull (design 6.3): fill at creation and when the maximum first rises from 0.
      const fills = field.resource.startFull === true && max > 0 && (stored.max <= 0 || options.fill?.has(fieldId) === true);
      const current = fills ? max : Math.min(stored.current, max);
      if (max !== stored.max || current !== stored.current) {
        if (resolvedState === state) resolvedState = { ...state, values: { ...state.values } };
        resolvedState.values[fieldId] = { current, max };
      }
      bindings.fields[fieldId] = current;
      bindings.fields[`${fieldId}.current`] = current;
      bindings.fields[`${fieldId}.max`] = max;
    } else {
      derivedValues[fieldId] = result.result;
      bindings.fields[fieldId] = result.result;
    }
    for (const diagnostic of result.diagnostics) {
      validations.push({
        validationId: `arithmetic_${expression.id}`,
        severity: "error",
        message: diagnostic.message,
        targetDefinitionId: fieldId,
      });
    }
    visiting.delete(fieldId);
    complete.add(fieldId);
    return { ok: true, value: null };
  };

  for (const fieldId of computedById.keys()) {
    const result = evaluateComputed(fieldId);
    if (!result.ok) return result;
  }

  const actionOwners = sheetActionOwners(packageValue);
  for (const validation of packageValue.validations) {
    if (validationOwner(packageValue, validation, actionOwners) !== entity.id) continue;
    const expression = expressions.get(validation.expressionId);
    if (expression === undefined) return invalidPackage(validation.expressionId);
    spent += expression.cost + dataObservationCost(expression.ast, capacities, computedCost);
    if (spent > packageValue.effectiveLimits.sheetEvaluationNodes) return budgetExceeded();
    const result = evaluate(expression, bindings);
    if (!result.ok) return invalidPackage(expression.id);
    if (result.result !== true || result.diagnostics.length > 0) {
      validations.push({
        validationId: validation.id,
        severity: validation.severity,
        message: validation.message,
        targetDefinitionId: validation.targetId,
      });
    }
  }

  return { ok: true, value: { state: resolvedState, derivedValues, validations } };
}

function normalizeEntryResources(
  packageValue: SystemPackageV1,
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
): RuntimeResult<RuntimeStateV1> {
  let next = state;
  let stored: ReturnType<typeof buildFieldBindings> | undefined;
  for (const entry of Object.values(state.entries)) {
    const template = effectiveEntryDefinition(packageValue, entry);
    const resources = template?.fields.filter((field): field is ResourceFieldV1 => field.kind === "resource" && field.maxExpressionId !== undefined) ?? [];
    if (template === undefined || resources.length === 0) continue;
    stored ??= buildFieldBindings(entity, state);
    const scope = entryItemScope(packageValue, template, entry, stored);
    for (const field of resources) {
      const value = scope.evaluateExpression(field.maxExpressionId!);
      if (typeof value !== "number" || !Number.isFinite(value)) return invalidPackage(field.maxExpressionId!);
      const max = boundedMaximum(field, value);
      const raw = entry.values[field.id];
      const current = typeof raw === "object" && raw !== null && "current" in raw && typeof raw.current === "number" ? raw.current : field.default.current;
      const previous = typeof raw === "object" && raw !== null && "max" in raw && typeof raw.max === "number" ? raw.max : field.default.max;
      const fills = field.startFull === true && max > 0 && previous <= 0;
      const nextValue = { current: fills ? max : Math.max(field.min, Math.min(current, max)), max };
      if (nextValue.current === current && nextValue.max === previous && raw !== undefined) continue;
      if (next === state) next = { ...state, entries: { ...state.entries } };
      const nextEntry = next.entries[entry.entryId]!;
      next.entries[entry.entryId] = { ...nextEntry, values: { ...nextEntry.values, [field.id]: nextValue } };
    }
  }
  return { ok: true, value: next };
}

function boundedMaximum(field: ResourceFieldV1, value: number): number {
  const bounded = Math.min(field.max, Math.max(field.min, value));
  const steps = Math.floor((bounded - field.min) / field.step + 1e-8);
  return Math.min(field.max, field.min + steps * field.step);
}

function invalidPackage(definitionId: string): RuntimeResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_package",
      message: "Published package runtime references are invalid.",
      definitionId,
    },
  };
}

function budgetExceeded(): RuntimeResult<never> {
  return {
    ok: false,
    error: { code: "budget_exceeded", message: "Runtime evaluation budget exceeded." },
  };
}
