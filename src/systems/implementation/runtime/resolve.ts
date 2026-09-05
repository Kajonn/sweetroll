import type {
  RuntimeResult,
  RuntimeScalar,
  RuntimeStateV1,
  RuntimeValidation,
} from "../../runtime.js";
import type {
  EntityDefinitionV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import { evaluate } from "../rules/evaluate.js";
import { buildFieldBindings } from "./state.js";

export type ObservedRuntimeValues = {
  derivedValues: Record<string, RuntimeScalar>;
  validations: RuntimeValidation[];
};

export function resolveObservedValues(
  packageValue: SystemPackageV1,
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
): RuntimeResult<ObservedRuntimeValues> {
  const expressions = new Map(packageValue.expressions.map((expression) => [expression.id, expression]));
  const computed = entity.fields.filter((field) => field.kind === "computed");
  const computedById = new Map(computed.map((field) => [field.id, field]));
  const bindings = buildFieldBindings(entity, state);
  const derivedValues: Record<string, RuntimeScalar> = {};
  const complete = new Set<string>();
  let spent = 0;

  const evaluateComputed = (fieldId: string): RuntimeResult<null> => {
    if (complete.has(fieldId)) return { ok: true, value: null };
    const field = computedById.get(fieldId);
    if (field === undefined) return { ok: true, value: null };
    const expression = expressions.get(field.expressionId);
    if (expression === undefined) return invalidPackage(field.expressionId);
    for (const dependency of expression.dependencies) {
      const dependencyResult = evaluateComputed(dependency);
      if (!dependencyResult.ok) return dependencyResult;
    }
    spent += expression.cost;
    if (spent > packageValue.effectiveLimits.expressionAstNodes) return budgetExceeded();
    const result = evaluate(expression, bindings);
    if (!result.ok) return invalidPackage(expression.id);
    derivedValues[field.id] = result.result;
    bindings[field.id] = result.result;
    complete.add(field.id);
    return { ok: true, value: null };
  };

  for (const field of computed) {
    const result = evaluateComputed(field.id);
    if (!result.ok) return result;
  }

  const ownedTargets = new Set(entity.fields.map((field) => field.id));
  ownedTargets.add(entity.id);
  const validations: RuntimeValidation[] = [];
  for (const validation of packageValue.validations) {
    if (!ownedTargets.has(validation.targetId)) continue;
    const expression = expressions.get(validation.expressionId);
    if (expression === undefined) return invalidPackage(validation.expressionId);
    spent += expression.cost;
    if (spent > packageValue.effectiveLimits.expressionAstNodes) return budgetExceeded();
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

  return { ok: true, value: { derivedValues, validations } };
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
