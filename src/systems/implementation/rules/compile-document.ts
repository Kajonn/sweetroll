import { validateDataset, fieldWithDatasetOptions } from "../package/reference-data.js";
import { dataObservationCost } from "./data.js";
import { sheetActionOwners, validationOwner } from "./owners.js";
import { slotEnvironment } from "./slots.js";
import { namedGroups } from "./groups.js";
import { outputPlaceholders, placeholderProblem } from "./outcomes.js";
import {validatePushPolicies} from "./push-policy.js";
import type { ActionV1, SystemDocumentV1, SystemPackageV1, TemplateKind, ValueType } from "../package/schema/index.js";
import type { UnsignedSystemPackageV1 } from "../package/schema/index.js";
import { signSystemPackage } from "../package/canonical.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import { compileExpression, type CompileResult, type CompiledExpressionBody } from "./compile.js";
import { entityFieldTypes, type ExpressionCompileEnv, type FieldBindingType } from "./typecheck.js";

export type CompileDocumentOpts = {
  systemId: string;
  versionId: string;
  semanticVersion: string;
};

/**
 * Character-entity fields a granted roll of a template of `kind` may read: the
 * fields shared (same id and value type) by every entity whose sheet shows a
 * slot accepting that kind. Works on documents and packages alike, so system
 * extensions can be checked against a published base package.
 */
export function grantedEntityFieldsForKind(
  rules: Pick<SystemDocumentV1, "entities" | "sheets" | "slots">,
  kind: TemplateKind,
): Record<string, FieldBindingType> {
  const eligibleSlots = new Set(rules.slots
    .filter((slot) => slot.accepts.includes(kind)).map((slot) => slot.id));
  const targets = new Set(rules.sheets.filter((sheet) => sheet.sections.some((section) =>
    section.elements.some((element) => element.kind === "slot" && eligibleSlots.has(element.slotId)),
  )).map((sheet) => sheet.targetEntityId));
  const environments = [...targets].map((id) => entityFieldTypes(rules.entities.find((entity) => entity.id === id)?.fields ?? []));
  const common = { ...(environments[0] ?? {}) };
  for (const fields of environments.slice(1)) {
    for (const id of Object.keys(common)) {
      if (common[id] !== fields[id]) delete common[id];
    }
  }
  return common;
}

export function actionInputTypes(inputs: readonly { id: string; valueType: string }[]): Record<string, ValueType> {
  const types: Record<string, ValueType> = {};
  for (const input of inputs) types[input.id] = actionInputToValueType(input);
  return types;
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
  const invalidData = document.referenceData.flatMap((dataset, index) => validateDataset(dataset, `/referenceData/${index}`));
  if (invalidData.length > 0) return { ok: false, diagnostics: invalidData };
  for (const owner of [...document.entities, ...document.templates]) {
    for (const field of owner.fields) {
      if ((field.kind !== "singleChoice" && field.kind !== "multiChoice") || field.optionsFrom === undefined) continue;
      const resolved = fieldWithDatasetOptions(field, document.referenceData);
      const defaults = Array.isArray(field.default) ? field.default : field.default === null ? [] : [field.default];
      if (resolved === field || !("options" in resolved) || defaults.some(id => !resolved.options.some(option => option.id === id))) {
        return scopeDiagnostic("invalid_expression", `${owner.id}.${field.id}`, "Choice defaults must belong to the selected dataset.");
      }
    }
  }
  const entityFields = new Map(document.entities.map(entity => [entity.id, new Map(entity.fields.map(field => [field.id, field]))]));
  for (const entity of document.entities) {
    entityEnvironments.set(entity.id, { fields: entityFieldTypes(entity.fields), inputs: {}, slots: slotEnvironment(document, entity.id) });
  }

  const actionsById = new Map(document.actions.map((action) => [action.id, action]));
  const actionTargets = new Map<string, string>();
  for (const [sheetIndex, sheet] of document.sheets.entries()) {
    for (const [sectionIndex, section] of sheet.sections.entries()) {
      for (const [elementIndex, element] of section.elements.entries()) {
        const path = `/sheets/${sheetIndex}/sections/${sectionIndex}/elements/${elementIndex}`;
        if (element.kind === "field" && !entityFields.get(sheet.targetEntityId)?.has(element.fieldId)) {
          return scopeDiagnostic("missing_reference", `${path}/fieldId`, "Field does not belong to the sheet target entity.");
        }
        if (element.kind === "resource" && entityFields.get(sheet.targetEntityId)?.get(element.resourceId)?.kind !== "resource") {
          return scopeDiagnostic("missing_reference", `${path}/resourceId`, "Resource does not belong to the sheet target entity.");
        }
        if (element.kind === "action") {
          const action = actionsById.get(element.actionId);
          if (
            action?.kind === "resourceBump"
            && entityFields.get(sheet.targetEntityId)?.get(action.resourceId)?.kind !== "resource"
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

  const computedOwners = new Map<string, Set<string>>();
  for (const entity of document.entities) {
    for (const field of entity.fields) {
      if (field.kind === "computed") addOwner(computedOwners, field.expressionId, entity.id);
      if (field.kind === "resource" && field.maxExpressionId !== undefined) {
        const formula = document.expressions.find(expression => expression.id === field.maxExpressionId);
        if (formula?.context !== "computed" || formula.resultType !== "number") {
          return scopeDiagnostic("invalid_expression", field.maxExpressionId, "A resource maximum requires a computed numeric expression.");
        }
        addOwner(computedOwners, field.maxExpressionId, entity.id);
      }
    }
  }
  // Dynamic sheet objects: template computed fields and granted roll actions
  // reference the same global expression pool. Templates own their expressions
  // exactly like entities — one expression id, one owner — so the shared-id
  // rejection and env scoping below apply unchanged.
  const templates = document.templates;
  const templateEnvironments = new Map<string, ExpressionCompileEnv>();
  for (const template of templates) {
    templateEnvironments.set(template.id, { fields: {}, item: entityFieldTypes(template.fields), inputs: {} });
    for (const field of template.fields) {
      if (field.kind === "computed") addOwner(computedOwners, field.expressionId, template.id);
    }
  }
  // A granted roll runs on the character carrying its entry. Only fields
  // present on every entity that can display this template's slot are safe to
  // reference; a template may be used by more than one sheet/entity.
  const grantedEntityFields = new Map<string, Record<string, FieldBindingType>>();
  for (const template of templates) {
    grantedEntityFields.set(template.id, grantedEntityFieldsForKind(document, template.kind));
  }
  const validationOwners = new Map<string, Set<string>>();
  const actionOwners = sheetActionOwners(document);
  const validationTargets = new Map<string, string>();
  for (const validation of document.validations) {
    const owner = validationOwner(document, validation, actionOwners);
    if (owner === undefined) {
      return scopeDiagnostic("missing_reference", `/validations/${document.validations.indexOf(validation)}/targetId`, "Select the entity that owns this validation target.");
    }
    validationTargets.set(validation.id, owner);
    addOwner(validationOwners, validation.expressionId, owner);
  }
  const rollActions = new Map<string, Array<Extract<SystemDocumentV1["actions"][number], { kind: "roll" }>>>();
  for (const action of document.actions) {
    if (action.kind !== "roll") continue;
    const actions = rollActions.get(action.expressionId) ?? [];
    actions.push(action);
    rollActions.set(action.expressionId, actions);
  }
  const templateRollActions = new Map<string, Array<{ templateId: string; action: Extract<ActionV1, { kind: "roll" }> }>>();
  for (const template of templates) {
    for (const action of template.grantedActions) {
      if (action.kind !== "roll") continue;
      const actions = templateRollActions.get(action.expressionId) ?? [];
      actions.push({ templateId: template.id, action });
      templateRollActions.set(action.expressionId, actions);
    }
  }

  // Outcome bands and details describe one roll action; they compile after it,
  // with the same fields and inputs plus the finished roll.
  type OutcomeUse = { action: Extract<ActionV1, { kind: "roll" }>; list: "outcomes" | "details"; path: string };
  const outcomeUses = new Map<string, OutcomeUse[]>();
  const describedActions: Array<{ action: Extract<ActionV1, { kind: "roll" }>; path: string }> = [
    ...document.actions.flatMap((action, index) => action.kind === "roll" ? [{ action, path: `/actions/${index}` }] : []),
    ...templates.flatMap((template, templateIndex) => template.grantedActions.flatMap((action, index) =>
      action.kind === "roll" ? [{ action, path: `/templates/${templateIndex}/grantedActions/${index}` }] : [])),
  ];
  for (const { action, path } of describedActions) {
    if (action.target && !entityEnvironments.has(action.target.entityId)) {
      return scopeDiagnostic("missing_reference", `${path}/target/entityId`, "Select an existing target entity.");
    }
    if ((action.target || action.respondsTo) && "nominal" in action && action.nominal === true) {
      return scopeDiagnostic("invalid_expression", path, "A nominal action cannot use a campaign roll context.");
    }
    for (const list of ["outcomes", "details"] as const) {
      for (const [index, entry] of (action[list] ?? []).entries()) {
        const uses = outcomeUses.get(entry.expressionId) ?? [];
        uses.push({ action, list, path: `${path}/${list}/${index}/expressionId` });
        outcomeUses.set(entry.expressionId, uses);
      }
    }
  }
  const rollEnvironments = new Map<string, ExpressionCompileEnv>();

  const compiled: CompiledExpressionBody[] = [];
  const deferredOutcomes: number[] = [];

  for (const [expressionIndex, expr] of document.expressions.entries()) {
    if (expr.context === "outcome") {
      deferredOutcomes.push(expressionIndex);
      continue;
    }
    if (outcomeUses.has(expr.id)) {
      return scopeDiagnostic("invalid_expression", outcomeUses.get(expr.id)![0]!.path, "An outcome or detail must use an expression of the outcome kind.");
    }
    const templateRolls = templateRollActions.get(expr.id) ?? [];
    const owners = expr.context === "computed"
      ? computedOwners.get(expr.id)
      : expr.context === "validation"
        ? validationOwners.get(expr.id)
        : new Set([
          ...(rollActions.get(expr.id) ?? []).map((action) => actionTargets.get(action.id)).filter((owner) => owner !== undefined),
          ...templateRolls.map((roll) => roll.templateId),
        ]);
    const actions = expr.context === "roll"
      ? [...(rollActions.get(expr.id) ?? []), ...templateRolls.map((roll) => roll.action)]
      : [];
    if ((owners?.size ?? 0) > 1 || actions.length > 1) {
      return scopeDiagnostic("invalid_expression", expr.id, "Expression cannot be shared across different owners.");
    }
    const owner = owners?.values().next().value as string | undefined;
    const entityEnv = owner === undefined ? undefined : entityEnvironments.get(owner);
    const templateEnv = owner === undefined ? undefined : templateEnvironments.get(owner);
    const env: ExpressionCompileEnv = {
      fields: templateRolls.length > 0 ? grantedEntityFields.get(owner ?? "") ?? {} : entityEnv?.fields ?? {},
      inputs: {},
      dice: document.dice,
      datasets: document.referenceData,
      ...(templateEnv?.item === undefined ? {} : { item: templateEnv.item }),
      ...(entityEnv?.slots === undefined ? {} : { slots: entityEnv.slots }),
    };
    const action = actions[0];
    if (action !== undefined) {
      if (action.target) env.target = entityEnvironments.get(action.target.entityId)!.fields;
      if (action.respondsTo) env.opposed = { total: "number" };
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
    compiled[expressionIndex] = result.value;
    if (expr.context === "roll") rollEnvironments.set(expr.id, env);
  }

  const expressionIndexes = new Map(document.expressions.map((expression, index) => [expression.id, index]));
  for (const expressionIndex of deferredOutcomes) {
    const expr = document.expressions[expressionIndex]!;
    const uses = outcomeUses.get(expr.id) ?? [];
    if (uses.length !== 1) {
      return scopeDiagnostic("invalid_expression", expr.id, uses.length === 0
        ? "An outcome expression must be used by one outcome or detail of a roll action."
        : "Expression cannot be shared across different owners.");
    }
    const { action, list } = uses[0]!;
    const rollIndex = expressionIndexes.get(action.expressionId);
    const rollEnv = rollEnvironments.get(action.expressionId);
    const roll = rollIndex === undefined ? undefined : compiled[rollIndex];
    if (rollEnv === undefined || roll === undefined) {
      return scopeDiagnostic("missing_reference", expr.id, "The roll this outcome describes does not compile.");
    }
    if (expr.resultType !== (list === "outcomes" ? "boolean" : "number")) {
      return scopeDiagnostic("invalid_expression", expr.id, list === "outcomes"
        ? "An outcome condition must be true or false."
        : "A detail must be a number.");
    }
    const result = compileExpression(expr.source, {
      env: { ...rollEnv, roll: { total: "number" } },
      resultType: expr.resultType,
      context: "outcome",
      rolledGroups: namedGroups(roll.ast),
      fallback: expr.fallback,
    });
    if (!result.ok) {
      return { ok: false, diagnostics: result.diagnostics.map((d) => ({ ...d, path: expr.id })) };
    }
    compiled[expressionIndex] = result.value;
  }
  for (const { action, path } of describedActions) {
    const env = rollEnvironments.get(action.expressionId);
    if (env === undefined) continue;
    for (const placeholder of outputPlaceholders(action.outputTemplate)) {
      const problem = placeholderProblem(placeholder, action, env);
      if (problem !== null) return scopeDiagnostic("invalid_expression", `${path}/outputTemplate`, problem);
    }
  }

  const cycle = computedCycle(document, compiled);
  if (cycle !== undefined) {
    return scopeDiagnostic("invalid_expression", cycle, "Computed field dependency cycle detected.");
  }
  // The runtime evaluates every computed field and owned validation of an
  // entity on each observation (runtime/resolve.ts). Reject a sheet that could
  // never be observed instead of publishing it.
  const compiledById = new Map(document.expressions.map((expression, index) => [expression.id, compiled[index]!]));
  for (const [entityIndex, entity] of document.entities.entries()) {
    const capacities = new Map(Object.entries(entityEnvironments.get(entity.id)?.slots ?? {}).map(([id, slot]) => [id, slot.capacity]));
    const costOf = (id: string) => {
      const expression = compiledById.get(id);
      return expression === undefined ? 0 : expression.cost + dataObservationCost(expression.ast, capacities);
    };
    let cost = 0;
    for (const field of entity.fields) {
      if (field.kind === "computed") cost += costOf(field.expressionId);
      if (field.kind === "resource" && field.maxExpressionId !== undefined) cost += costOf(field.maxExpressionId);
    }
    for (const validation of document.validations) {
      if (validationTargets.get(validation.id) === entity.id) cost += costOf(validation.expressionId);
    }
    if (cost > PACKAGE_LIMITS.sheetEvaluationNodes) {
      return scopeDiagnostic(
        "limit_exceeded",
        `/entities/${entityIndex}/fields`,
        `Computed fields and validations of "${entity.label}" need ${cost} evaluation steps; the limit is ${PACKAGE_LIMITS.sheetEvaluationNodes}.`,
      );
    }
  }

  const unsigned: UnsignedSystemPackageV1 = {
    schemaVersion: document.schemaVersion,
    systemId: opts.systemId,
    versionId: opts.versionId,
    semanticVersion: opts.semanticVersion,
    name: document.metadata.name,
    description: document.metadata.description,
    language: document.metadata.language,
    defaultDice: document.metadata.defaultDice,
    ...(document.metadata.presentation === undefined ? {} : { presentation: document.metadata.presentation }),
    entities: document.entities.map(entity => ({ ...entity, fields: entity.fields.map(field => fieldWithDatasetOptions(field, document.referenceData)) })),
    ...(document.dice === undefined ? {} : { dice: document.dice }),
    referenceData: document.referenceData,
    sheets: document.sheets,
    expressions: compiled.map((b, i) => ({ id: document.expressions[i]!.id, ...b })),
    actions: document.actions,
    validations: document.validations.map(validation => ({ ...validation, targetEntityId: validationTargets.get(validation.id)! })),
    templates: document.templates.map(template => ({ ...template, fields: template.fields.map(field => fieldWithDatasetOptions(field, document.referenceData)) })),
    slots: document.slots,
    effectiveLimits: {
      expressionBytes: PACKAGE_LIMITS.expressionBytes,
      expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
      expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
      sheetEvaluationNodes: PACKAGE_LIMITS.sheetEvaluationNodes,
      dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
      sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
    },
  };

  const pushErrors=validatePushPolicies(unsigned);
  if(pushErrors.length)return {ok:false,diagnostics:pushErrors};
  return { ok: true, value: signSystemPackage(unsigned) };
}

function addOwner(owners: Map<string, Set<string>>, expressionId: string, owner: string): void {
  const expressionOwners = owners.get(expressionId) ?? new Set<string>();
  expressionOwners.add(owner);
  owners.set(expressionId, expressionOwners);
}

function computedCycle(
  document: SystemDocumentV1,
  compiled: CompiledExpressionBody[],
): string | undefined {
  const compiledById = new Map(document.expressions.map((expression, index) => [expression.id, compiled[index]!]));
  for (const entity of document.entities) {
    const computed = new Map(entity.fields.flatMap(field => {
      const expressionId = field.kind === "computed" ? field.expressionId
        : field.kind === "resource" ? field.maxExpressionId : undefined;
      return expressionId === undefined ? [] : [[field.id, { expressionId }] as const];
    }));
    const cycle = cycleInComputedFields(computed, compiledById);
    if (cycle !== undefined) return cycle;
  }
  for (const template of document.templates) {
    const computed = new Map(template.fields
      .filter((field) => field.kind === "computed")
      .map((field) => [field.id, field]));
    const cycle = cycleInComputedFields(computed, compiledById);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

export function cycleInComputedFields(
  computed: Map<string, { expressionId: string }>,
  compiledById: Map<string, CompiledExpressionBody>,
): string | undefined {
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
  return undefined;
}

function scopeDiagnostic(
  code: string,
  path: string,
  message: string,
): CompileResult<never> {
  return { ok: false, diagnostics: [{ code, path, message }] };
}
