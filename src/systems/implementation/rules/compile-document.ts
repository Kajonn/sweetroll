import { validateDataset, fieldWithDatasetOptions } from "../package/reference-data.js";
import { dataObservationCost } from "./data.js";
import { sheetActionOwners, validationOwner } from "./owners.js";
import { computedAggregateCost, slotEnvironment } from "./slots.js";
import { namedGroups } from "./groups.js";
import { outputPlaceholders, placeholderProblem } from "./outcomes.js";
import { targetEntityIds } from "./targets.js";
import { presetProblem } from "../runtime/presets.js";
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
  /** Template formulas read stored character fields only, so sheet values never depend on themselves (S11). */
  storedOnly = false,
): Record<string, FieldBindingType> {
  const eligibleSlots = new Set(rules.slots
    .filter((slot) => slot.accepts.includes(kind)).map((slot) => slot.id));
  const targets = new Set(rules.sheets.filter((sheet) => sheet.sections.some((section) =>
    section.elements.some((element) => element.kind === "slot" && eligibleSlots.has(element.slotId)),
  )).map((sheet) => sheet.targetEntityId));
  const environments = [...targets].map((id) => entityFieldTypes((rules.entities.find((entity) => entity.id === id)?.fields ?? [])
    .filter((field) => !storedOnly || field.kind !== "computed")));
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
  for (const [entityIndex, entity] of document.entities.entries()) {
    const problem = presetProblem(entity, document.referenceData);
    if (problem !== null) return scopeDiagnostic("invalid_expression", `/entities/${entityIndex}/presetsFrom`, problem);
  }
  const entityFields = new Map(document.entities.map(entity => [entity.id, new Map(entity.fields.map(field => [field.id, field]))]));
  for (const entity of document.entities) {
    entityEnvironments.set(entity.id, { fields: entityFieldTypes(entity.fields), inputs: {}, slots: slotEnvironment(document, entity.id) });
  }

  const actionsById = new Map(document.actions.map((action) => [action.id, action]));
  const actionTargets = new Map<string, string>();
  // Design 6.3 (SRD gaps S9): a section or element shows while a boolean field is true.
  const isCondition = (entityId: string, fieldId: string | undefined) => {
    if (fieldId === undefined) return true;
    const field = entityFields.get(entityId)?.get(fieldId);
    return field?.kind === "boolean" || (field?.kind === "computed" && field.valueType === "boolean");
  };
  for (const [sheetIndex, sheet] of document.sheets.entries()) {
    for (const [sectionIndex, section] of sheet.sections.entries()) {
      if (!isCondition(sheet.targetEntityId, section.visibleWhen)) {
        return scopeDiagnostic("invalid_expression", `/sheets/${sheetIndex}/sections/${sectionIndex}/visibleWhen`, "Show the section by a true or false field of the sheet's entity.");
      }
      for (const [elementIndex, element] of section.elements.entries()) {
        const path = `/sheets/${sheetIndex}/sections/${sectionIndex}/elements/${elementIndex}`;
        if (!isCondition(sheet.targetEntityId, element.visibleWhen)) {
          return scopeDiagnostic("invalid_expression", `${path}/visibleWhen`, "Show the element by a true or false field of the sheet's entity.");
        }
        if (element.kind === "field" && !entityFields.get(sheet.targetEntityId)?.has(element.fieldId)) {
          return scopeDiagnostic("missing_reference", `${path}/fieldId`, "Field does not belong to the sheet target entity.");
        }
        if (element.kind === "resource" && entityFields.get(sheet.targetEntityId)?.get(element.resourceId)?.kind !== "resource") {
          return scopeDiagnostic("missing_reference", `${path}/resourceId`, "Resource does not belong to the sheet target entity.");
        }
        if (element.kind === "action") {
          const action = actionsById.get(element.actionId);
          const resourceIds = action?.kind === "resourceBump" ? [action.resourceId]
            : action?.kind === "resourceBatch" ? action.steps.map(step => step.resourceId) : [];
          if (resourceIds.some(resourceId => entityFields.get(sheet.targetEntityId)?.get(resourceId)?.kind !== "resource")) {
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
  // reference the same global expression pool. Several templates may share one
  // expression (design 6.4, SRD gaps S1): it compiles against the fields every
  // owning template defines with the same type. Entities keep one owner.
  const templates = document.templates;
  const templateEnvironments = new Map<string, ExpressionCompileEnv>();
  for (const template of templates) {
    templateEnvironments.set(template.id, { fields: {}, item: entityFieldTypes(template.fields), inputs: {} });
    for (const field of template.fields) {
      if (field.kind === "computed") addOwner(computedOwners, field.expressionId, template.id);
      if (field.kind === "resource" && field.maxExpressionId !== undefined) {
        const formula = document.expressions.find(expression => expression.id === field.maxExpressionId);
        if (formula?.context !== "computed" || formula.resultType !== "number") {
          return scopeDiagnostic("invalid_expression", field.maxExpressionId, "A resource maximum requires a computed numeric expression.");
        }
        addOwner(computedOwners, field.maxExpressionId, template.id);
      }
    }
  }
  const storedEntityFields = new Map(templates.map(template => [template.id, grantedEntityFieldsForKind(document, template.kind, true)]));
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
  type OutcomeUse = { action: Extract<ActionV1, { kind: "roll" }>; actionPath: string; list: "outcomes" | "details"; path: string };
  const outcomeUses = new Map<string, OutcomeUse[]>();
  const describedActions: Array<{ action: Extract<ActionV1, { kind: "roll" }>; path: string }> = [
    ...document.actions.flatMap((action, index) => action.kind === "roll" ? [{ action, path: `/actions/${index}` }] : []),
    ...templates.flatMap((template, templateIndex) => template.grantedActions.flatMap((action, index) =>
      action.kind === "roll" ? [{ action, path: `/templates/${templateIndex}/grantedActions/${index}` }] : [])),
  ];
  for (const { action, path } of describedActions) {
    if (action.target && !targetEntityIds(action.target).every(id => entityEnvironments.has(id))) {
      return scopeDiagnostic("missing_reference", `${path}/target/entityId`, "Select an existing target entity.");
    }
    if ((action.target || action.respondsTo) && "nominal" in action && action.nominal === true) {
      return scopeDiagnostic("invalid_expression", path, "A nominal action cannot use a campaign roll context.");
    }
    for (const list of ["outcomes", "details"] as const) {
      for (const [index, entry] of (action[list] ?? []).entries()) {
        const uses = outcomeUses.get(entry.expressionId) ?? [];
        uses.push({ action, actionPath: path, list, path: `${path}/${list}/${index}/expressionId` });
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
    const ownerIds = [...(owners ?? [])];
    const sharedByTemplates = ownerIds.length > 0 && ownerIds.every(id => templateEnvironments.has(id))
      && (rollActions.get(expr.id) ?? []).length === 0;
    if (!sharedByTemplates && (ownerIds.length > 1 || actions.length > 1)) {
      return scopeDiagnostic("invalid_expression", expr.id, "Expression cannot be shared across different owners.");
    }
    if (actions.length > 1 && actions.some(other => !sameRollContract(actions[0]!, other))) {
      return scopeDiagnostic("invalid_expression", expr.id, "Actions that share a formula must declare the same inputs, target, outcomes and details.");
    }
    const owner = ownerIds[0];
    const entityEnv = owner === undefined ? undefined : entityEnvironments.get(owner);
    const templateOwned = ownerIds.length > 0 && ownerIds.every(id => templateEnvironments.has(id));
    const templateEnv = templateOwned
      ? { item: commonFields(ownerIds.map(id => templateEnvironments.get(id)?.item ?? {})) } : undefined;
    const env: ExpressionCompileEnv = {
      fields: templateRolls.length > 0 ? commonFields(ownerIds.map(id => grantedEntityFields.get(id) ?? {}))
        : templateEnv !== undefined && expr.context === "computed" ? commonFields(ownerIds.map(id => storedEntityFields.get(id) ?? {}))
          : entityEnv?.fields ?? {},
      inputs: {},
      dice: document.dice,
      datasets: document.referenceData,
      ...(templateEnv?.item === undefined ? {} : { item: templateEnv.item }),
      ...(entityEnv?.slots === undefined ? {} : { slots: entityEnv.slots }),
    };
    const action = actions[0];
    if (action !== undefined) {
      // An optional target is read by outcomes and details only (added below).
      if (action.target && !action.target.optional) env.target = commonTargetFields(action.target, entityEnvironments);
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
    // Actions that share a roll formula share its outcomes too.
    const sharedRoll = uses.length > 1 && new Set(uses.map(use => use.actionPath)).size === uses.length
      && uses.every(use => use.list === uses[0]!.list && use.action.expressionId === uses[0]!.action.expressionId);
    if (uses.length !== 1 && !sharedRoll) {
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
      env: { ...rollEnv, roll: { total: "number" }, ...(action.target ? { target: commonTargetFields(action.target, entityEnvironments) } : {}) },
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
  const computedCost = computedAggregateCost(document, compiledById);
  for (const [entityIndex, entity] of document.entities.entries()) {
    const capacities = new Map(Object.entries(entityEnvironments.get(entity.id)?.slots ?? {}).map(([id, slot]) => [id, slot.capacity]));
    const costOf = (id: string) => {
      const expression = compiledById.get(id);
      return expression === undefined ? 0 : expression.cost + dataObservationCost(expression.ast, capacities, computedCost);
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
    ...(document.decks === undefined ? {} : { decks: document.decks }),
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
  const signed = signSystemPackage(unsigned);
  // A package is larger than its document (compiled formulas, resolved choice
  // options). An oversized one could be published but never imported again.
  const packageBytes = new TextEncoder().encode(JSON.stringify(signed)).length;
  if (packageBytes > PACKAGE_LIMITS.encodedBytes) {
    return scopeDiagnostic("limit_exceeded", "", `The compiled system needs ${packageBytes} bytes; the limit is ${PACKAGE_LIMITS.encodedBytes}.`);
  }
  return { ok: true, value: signed };
}

/** Fields every set defines with the same type. */
function commonFields(sets: ReadonlyArray<Record<string, FieldBindingType>>): Record<string, FieldBindingType> {
  const [first, ...rest] = sets;
  return Object.fromEntries(Object.entries(first ?? {}).filter(([id, type]) => rest.every(fields => fields[id] === type)));
}

/** Roll actions that share one formula must agree on everything the formula and its outcomes read. */
function sameRollContract(left: Extract<ActionV1, { kind: "roll" }>, right: Extract<ActionV1, { kind: "roll" }>): boolean {
  const contract = (action: Extract<ActionV1, { kind: "roll" }>) => JSON.stringify([
    action.inputs.map(({ id, valueType }) => [id, valueType]), action.target ?? null, action.respondsTo ?? false,
    (action.outcomes ?? []).map(entry => entry.expressionId), (action.details ?? []).map(entry => entry.expressionId),
  ]);
  return contract(left) === contract(right);
}

/** Fields every possible target entity defines with the same type. */
function commonTargetFields(
  target: { entityId: string; otherEntityIds?: readonly string[] },
  environments: ReadonlyMap<string, ExpressionCompileEnv>,
): Record<string, FieldBindingType> {
  const [first, ...rest] = targetEntityIds(target).map(id => environments.get(id)?.fields ?? {});
  const common = { ...first };
  for (const fields of rest) for (const id of Object.keys(common)) if (common[id] !== fields[id]) delete common[id];
  return common;
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
