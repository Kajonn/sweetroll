import type { FieldV1, SystemDocumentV1, SystemPackageV1, ValueType } from "../package/schema/index.js";
import type { UnsignedSystemPackageV1 } from "../package/schema/index.js";
import { signSystemPackage } from "../package/canonical.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import { compileExpression, type CompileResult, type CompiledExpressionBody } from "./compile.js";
import type { ExpressionCompileEnv } from "./typecheck.js";

export type CompileDocumentOpts = {
  systemId: string;
  versionId: string;
  semanticVersion: string;
};

function fieldToValueType(field: FieldV1): ValueType | undefined {
  switch (field.kind) {
    case "text": return "text";
    case "integer": return "number";
    case "decimal": return "number";
    case "boolean": return "boolean";
    case "singleChoice": return "text";
    case "multiChoice": return "text";
    case "resource": return "number";
    case "computed": return field.valueType;
    case "image": return undefined;
  }
}

function actionInputToValueType(input: { valueType: string }): ValueType {
  switch (input.valueType) {
    case "integer": return "number";
    case "decimal": return "number";
    case "boolean": return "boolean";
    case "text": return "text";
  }
  return "text";
}

export function compileDocument(document: SystemDocumentV1, opts: CompileDocumentOpts): CompileResult<SystemPackageV1> {
  const entityEnvironments = new Map<string, ExpressionCompileEnv>();
  const fieldOwners = new Map<string, string>();
  for (const entity of document.entities) {
    const fields: Record<string, ValueType> = {};
    for (const field of entity.fields) {
      fieldOwners.set(field.id, entity.id);
      const valueType = fieldToValueType(field);
      if (valueType !== undefined) fields[field.id] = valueType;
    }
    entityEnvironments.set(entity.id, { fields, inputs: {} });
  }

  const actionsById = new Map(document.actions.map((action) => [action.id, action]));
  const actionTargets = new Map<string, string>();
  for (const [sheetIndex, sheet] of document.sheets.entries()) {
    for (const [sectionIndex, section] of sheet.sections.entries()) {
      for (const [elementIndex, element] of section.elements.entries()) {
        const path = `/sheets/${sheetIndex}/sections/${sectionIndex}/elements/${elementIndex}`;
        if (element.kind === "field" && fieldOwners.get(element.fieldId) !== sheet.targetEntityId) {
          return scopeDiagnostic("missing_reference", `${path}/fieldId`, "Field does not belong to the sheet target entity.");
        }
        if (element.kind === "resource" && fieldOwners.get(element.resourceId) !== sheet.targetEntityId) {
          return scopeDiagnostic("missing_reference", `${path}/resourceId`, "Resource does not belong to the sheet target entity.");
        }
        if (element.kind === "action") {
          const action = actionsById.get(element.actionId);
          if (
            action?.kind === "resourceBump"
            && fieldOwners.get(action.resourceId) !== sheet.targetEntityId
          ) {
            return scopeDiagnostic("missing_reference", `${path}/actionId`, "Action does not belong to the sheet target entity.");
          }
          const priorTarget = actionTargets.get(element.actionId);
          if (priorTarget !== undefined && priorTarget !== sheet.targetEntityId) {
            return scopeDiagnostic("invalid_expression", `${path}/actionId`, "Action cannot target multiple entities.");
          }
          actionTargets.set(element.actionId, sheet.targetEntityId);
        }
      }
    }
  }

  const computedOwners = new Map<string, string>();
  for (const entity of document.entities) {
    for (const field of entity.fields) {
      if (field.kind === "computed") computedOwners.set(field.expressionId, entity.id);
    }
  }
  const validationOwners = new Map(document.validations.map((validation) => {
    const owner = fieldOwners.get(validation.targetId)
      ?? (entityEnvironments.has(validation.targetId) ? validation.targetId : undefined)
      ?? actionTargets.get(validation.targetId);
    return [validation.expressionId, owner];
  }));
  const rollActions = new Map(document.actions
    .filter((action) => action.kind === "roll")
    .map((action) => [action.expressionId, action]));

  const compiled: CompiledExpressionBody[] = [];

  for (const expr of document.expressions) {
    const owner = expr.context === "computed"
      ? computedOwners.get(expr.id)
      : expr.context === "validation"
        ? validationOwners.get(expr.id)
        : actionTargets.get(rollActions.get(expr.id)?.id ?? "");
    const entityEnv = owner === undefined ? undefined : entityEnvironments.get(owner);
    const env: ExpressionCompileEnv = {
      fields: entityEnv?.fields ?? {},
      inputs: {},
    };
    const action = expr.context === "roll" ? rollActions.get(expr.id) : undefined;
    if (action !== undefined) {
      for (const actionInput of action.inputs) {
        env.inputs[actionInput.id] = actionInputToValueType(actionInput);
      }
    }
    const result = compileExpression(expr.source, {
      env,
      resultType: expr.resultType,
      context: expr.context,
      fallback: expr.fallback,
    });
    if (!result.ok) {
      return {
        ok: false,
        diagnostics: result.diagnostics.map((d) => ({ ...d, path: expr.id })),
      };
    }
    compiled.push(result.value);
  }

  const cycle = computedCycle(document, compiled);
  if (cycle !== undefined) {
    return scopeDiagnostic("invalid_expression", cycle, "Computed field dependency cycle detected.");
  }

  const unsigned: UnsignedSystemPackageV1 = {
    schemaVersion: "1.0",
    systemId: opts.systemId,
    versionId: opts.versionId,
    semanticVersion: opts.semanticVersion,
    name: document.metadata.name,
    description: document.metadata.description,
    language: document.metadata.language,
    defaultDice: document.metadata.defaultDice,
    entities: document.entities,
    referenceData: document.referenceData,
    sheets: document.sheets,
    expressions: compiled.map((b, i) => ({ id: document.expressions[i]!.id, ...b })),
    actions: document.actions,
    validations: document.validations,
    effectiveLimits: {
      expressionBytes: PACKAGE_LIMITS.expressionBytes,
      expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
      expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
      dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
      sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
    },
  };

  return { ok: true, value: signSystemPackage(unsigned) };
}

function computedCycle(
  document: SystemDocumentV1,
  compiled: CompiledExpressionBody[],
): string | undefined {
  const compiledById = new Map(document.expressions.map((expression, index) => [expression.id, compiled[index]!]));
  for (const entity of document.entities) {
    const computed = new Map(entity.fields
      .filter((field) => field.kind === "computed")
      .map((field) => [field.id, field]));
    const visiting = new Set<string>();
    const complete = new Set<string>();
    const visit = (fieldId: string): string | undefined => {
      if (complete.has(fieldId)) return undefined;
      const field = computed.get(fieldId);
      if (field === undefined) return undefined;
      visiting.add(fieldId);
      for (const dependency of compiledById.get(field.expressionId)?.dependencies ?? []) {
        if (!computed.has(dependency)) continue;
        if (visiting.has(dependency)) return field.expressionId;
        const cycle = visit(dependency);
        if (cycle !== undefined) return cycle;
      }
      visiting.delete(fieldId);
      complete.add(fieldId);
      return undefined;
    };
    for (const fieldId of computed.keys()) {
      const cycle = visit(fieldId);
      if (cycle !== undefined) return cycle;
    }
  }
  return undefined;
}

function scopeDiagnostic(
  code: string,
  path: string,
  message: string,
): CompileResult<never> {
  return { ok: false, diagnostics: [{ code, path, message }] };
}
