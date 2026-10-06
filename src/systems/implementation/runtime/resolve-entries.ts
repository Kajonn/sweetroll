import type {
  ActionInputV1,
  CharacterEntryV1,
  EntityDefinitionV1,
  GrantedActionV1,
  ObjectTemplateV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import type {
  CommandExecutionId,
  DefinitionId,
  NominalActionResult,
  NormalizedRoll,
  RuntimeResult,
  RuntimeScalar,
  RuntimeStateV1,
} from "../../runtime.js";
import { createDeterministicRng } from "./deterministic-rng.js";
import { buildEntryScope, validateEntryForSlot } from "./entries.js";
import { resolveObservedValues } from "./resolve.js";
import { buildFieldBindings } from "./state.js";
import { evaluate } from "../rules/evaluate.js";

export type GrantedActionRequest = {
  packageValue: SystemPackageV1;
  entity: EntityDefinitionV1;
  state: RuntimeStateV1;
  entryId: string;
  actionId: DefinitionId;
  inputs: Record<DefinitionId, unknown>;
  executionId: CommandExecutionId;
  authoritativeRollSecret: string;
};

export type GrantedActionOutcome = {
  state: RuntimeStateV1;
  changedDefinitionIds: DefinitionId[];
  roll: NormalizedRoll | null;
  nominal: NominalActionResult | null;
};

export type GrantedActionOwnership = {
  entry: CharacterEntryV1;
  template: ObjectTemplateV1;
  action: GrantedActionV1;
};

/**
 * Granted-action lookup for `{entryId, actionId}` intents. Entity actions
 * stay on `findOwnedAction` (sheet ownership over package actions); granted
 * actions live on templates and resolve through the entry in state instead.
 * Returns undefined when the entry, template, or granted action is unknown —
 * the caller maps that to `bad_request`, mirroring the entity ownership
 * rejection. Custom entries (`templateId: null`) never own actions.
 */
export function findGrantedAction(
  packageValue: SystemPackageV1,
  state: RuntimeStateV1,
  entryId: string,
  actionId: string,
): GrantedActionOwnership | undefined {
  const entry = (state.entries ?? {})[entryId];
  if (entry === undefined || entry.templateId === null) return undefined;
  const template = (packageValue.templates ?? []).find((candidate) => candidate.id === entry.templateId);
  if (template === undefined) return undefined;
  const action = template.grantedActions.find((candidate) => candidate.id === actionId);
  if (action === undefined) return undefined;
  return { entry, template, action };
}

/**
 * Resolves a template-granted action against the merged scope (character
 * fields + entry values, entry winning on collision). Roll actions evaluate
 * like entity actions, including execution-supplied `inputs`; resource bumps
 * mutate the entry's resource value inside a cloned state; nominal actions
 * short-circuit to an activity-only result with display text and no state
 * change, no roll, and no evaluation.
 */
export function resolveGrantedAction(request: GrantedActionRequest): RuntimeResult<GrantedActionOutcome> {
  const owned = findGrantedAction(request.packageValue, request.state, request.entryId, request.actionId);
  if (owned === undefined) {
    const entry = (request.state.entries ?? {})[request.entryId];
    if (entry === undefined) {
      return badRequest("Character entry not found.", request.entryId);
    }
    if (entry.templateId === null) {
      return badRequest("Custom entries grant no actions.", request.actionId);
    }
    return badRequest("Action is not granted by the entry.", request.actionId);
  }
  const { entry, template, action } = owned;

  const siblings = Object.values(request.state.entries ?? {}).filter(
    (candidate) => candidate.slotId === entry.slotId && candidate.entryId !== entry.entryId,
  ).length;
  const validation = validateEntryForSlot(
    entry,
    request.packageValue.slots ?? [],
    request.packageValue.templates ?? [],
    siblings,
  );
  if (!validation.ok) {
    return badRequest(validation.message, validation.definitionId ?? request.actionId);
  }

  if (action.nominal === true) {
    return {
      ok: true,
      value: {
        state: request.state,
        changedDefinitionIds: [],
        roll: null,
        nominal: {
          actionId: action.id,
          entryId: entry.entryId,
          output: action.kind === "roll" ? action.outputTemplate : action.label,
        },
      },
    };
  }

  if (action.kind === "resourceBump") {
    return resolveGrantedBump(request, entry, template, action);
  }

  const actionInputs = decodeActionInputs(action.inputs, request.inputs);
  if (!actionInputs.ok) return actionInputs;
  const expression = request.packageValue.expressions.find((candidate) => candidate.id === action.expressionId);
  if (expression === undefined || expression.context !== "roll") return invalidPackage(action.expressionId);
  const observed = resolveObservedValues(request.packageValue, request.entity, request.state);
  if (!observed.ok) return observed;
  const fields = grantedFieldScope(request, template, entry, observed.value.derivedValues);
  const evaluated = evaluate(
    expression,
    { fields, inputs: actionInputs.value },
    createDeterministicRng(request.authoritativeRollSecret, request.executionId),
    request.packageValue.effectiveLimits,
  );
  if (!evaluated.ok) {
    return evaluated.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded")
      ? budgetExceeded()
      : invalidPackage(expression.id);
  }
  if (evaluated.roll === null) return invalidPackage(expression.id);
  return {
    ok: true,
    value: {
      state: request.state,
      changedDefinitionIds: [],
      roll: {
        actionId: action.id,
        expression: evaluated.roll.expression,
        dice: evaluated.roll.dice,
        bindings: evaluated.bindings,
        total: evaluated.roll.total,
        output: action.outputTemplate.split("{total}").join(String(evaluated.roll.total)),
        audience: "owner_only",
      },
      nominal: null,
    },
  };
}

/**
 * Granted-action input decoding, shared with the entity action path in
 * `systems/runtime.ts`: granted roll actions supply `inputs` at execution
 * exactly like entity roll actions do.
 */
export function decodeActionInputs(
  definitions: ActionInputV1[],
  supplied: Record<string, unknown>,
): RuntimeResult<Record<string, RuntimeScalar>> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const id of Object.keys(supplied)) {
    if (!byId.has(id)) return badRequest("Action input is unknown.", id);
  }
  const values: Record<string, RuntimeScalar> = {};
  for (const definition of definitions) {
    if (definition.required && !Object.hasOwn(supplied, definition.id)) {
      return badRequest("Required action input is missing.", definition.id);
    }
    const value = Object.hasOwn(supplied, definition.id) ? supplied[definition.id] : definition.default;
    if (!validActionInput(definition, value)) return badRequest("Action input value is invalid.", definition.id);
    values[definition.id] = value as RuntimeScalar;
  }
  return { ok: true, value: values };
}

function validActionInput(definition: ActionInputV1, value: unknown): boolean {
  switch (definition.valueType) {
    case "integer":
      return Number.isInteger(value);
    case "decimal":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "text":
      return typeof value === "string";
  }
}

function resolveGrantedBump(
  request: GrantedActionRequest,
  entry: CharacterEntryV1,
  template: ObjectTemplateV1,
  action: Extract<GrantedActionV1, { kind: "resourceBump" }>,
): RuntimeResult<GrantedActionOutcome> {
  const field = template.fields.find((candidate) => candidate.id === action.resourceId);
  if (field?.kind !== "resource") return invalidPackage(action.resourceId);
  const stored = entry.values[action.resourceId];
  if (!isResourceValue(stored)) {
    return badRequest("Granted resource action exceeds its bounds.", action.resourceId);
  }
  const target = action.operation.kind === "reset"
    ? field.resetTo === "max" ? stored.max : field.min
    : stored.current + action.operation.amount;
  if (
    !Number.isFinite(target)
    || target < field.min
    || target > stored.max
    || !onStep(target, field.min, field.step)
  ) {
    return badRequest("Granted resource action exceeds its bounds.", action.resourceId);
  }
  const changed = target !== stored.current;
  const nextState = structuredClone(request.state);
  nextState.entries = {
    ...(request.state.entries ?? {}),
    [entry.entryId]: {
      ...entry,
      values: { ...entry.values, [action.resourceId]: { current: target, max: stored.max } },
    },
  };
  return {
    ok: true,
    value: {
      state: nextState,
      changedDefinitionIds: changed ? [action.resourceId] : [],
      roll: null,
      nominal: null,
    },
  };
}

/**
 * Merged roll scope for granted actions: character bindings (stored fields,
 * resources as their current value, plus derived values) under entry values.
 * Entry resource objects bind as their current value, mirroring
 * `buildFieldBindings`, so `fields.<resource>` stays numeric in both scopes.
 */
function grantedFieldScope(
  request: GrantedActionRequest,
  template: ObjectTemplateV1,
  entry: CharacterEntryV1,
  derivedValues: Record<string, RuntimeScalar>,
): Record<string, RuntimeScalar> {
  const characterFields: Record<string, unknown> = {
    ...buildFieldBindings(request.entity, request.state),
    ...derivedValues,
  };
  const templateFields = new Map(template.fields.map((field) => [field.id, field]));
  const entryScope: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(entry.values)) {
    const field = templateFields.get(id);
    if (field?.kind === "resource" && isResourceValue(value)) {
      entryScope[id] = value.current;
    } else {
      entryScope[id] = value;
    }
  }
  return buildEntryScope(characterFields, entryScope) as Record<string, RuntimeScalar>;
}

function isResourceValue(value: unknown): value is { current: number; max: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { current, max } = value as { current: unknown; max: unknown };
  return typeof current === "number" && typeof max === "number"
    && Number.isFinite(current) && Number.isFinite(max);
}

function onStep(value: number, min: number, step: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  const quotient = (value - min) / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function badRequest(message: string, definitionId?: string): RuntimeResult<never> {
  return {
    ok: false,
    error: { code: "bad_request", message, ...(definitionId === undefined ? {} : { definitionId }) },
  };
}

function budgetExceeded(): RuntimeResult<never> {
  return {
    ok: false,
    error: { code: "budget_exceeded", message: "Runtime evaluation budget exceeded." },
  };
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
