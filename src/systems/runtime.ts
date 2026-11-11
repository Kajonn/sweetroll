import { characterRuleBindings } from "./implementation/runtime/rule-bindings.js";
import { derivedEntryError, slotsForEntity } from "./implementation/runtime/effective-entry.js";
import {findOwnedAction} from "./implementation/runtime/action-ownership.js";
import {makePushContext,resolveRuntimePush} from "./implementation/runtime/push.js";
import type {PushContext} from "./implementation/runtime/push-context.js";
export type {PushContext} from "./implementation/runtime/push-context.js";
import type { DieResult, RollBreakdown } from "./implementation/rules/result.js";
import { PublishedPackageCorruptError, type PublishedExtensionLoader, type PublishedPackageLoader } from "./implementation/runtime/package-loader.js";
import { createEffectivePackageLoader, type EffectivePackageLoader } from "./implementation/runtime/composition-loader.js";
import { unqualifiedId, type ExtensionRef } from "./implementation/rules/compose.js";
export type { ExtensionRef } from "./implementation/rules/compose.js";
import { buildCharacterProjection } from "./implementation/runtime/projection.js";
import { decodeActionInputs, resolveGrantedAction } from "./implementation/runtime/resolve-entries.js";
import { resolveObservedValues } from "./implementation/runtime/resolve.js";
import { createDeterministicRng } from "./implementation/runtime/deterministic-rng.js";
import { decodeRuntimeState, initializeState } from "./implementation/runtime/state.js";
import { actionEvaluationFailure } from "./implementation/runtime/action-evaluation.js";
import { evaluate, type BindingValue } from "./implementation/rules/evaluate.js";
import {
  checkVersionChange,
  type VersionChangeDirection,
  type VersionChangeReport,
} from "./implementation/runtime/version-change.js";

export type { VersionChangeDirection, VersionChangeReport } from "./implementation/runtime/version-change.js";
import type { CharacterEntryV1, EntityDefinitionV1, FieldV1, ObjectTemplateV1, SlotDefinitionV1, SystemPackageV1, TemplateKind } from "./implementation/package/schema/index.js";

export { resolveGrantedAction } from "./implementation/runtime/resolve-entries.js";
export type {
  GrantedActionOutcome,
  GrantedActionOwnership,
  GrantedActionRequest,
} from "./implementation/runtime/resolve-entries.js";

export type VersionId = string;
export type DefinitionId = string;
export type CommandExecutionId = string;

export type RuntimeScalar = string | number | boolean | null;
export type RuntimeResourceValue = { current: number; max: number };
export type RuntimeStoredValue =
  | RuntimeScalar
  | DefinitionId[]
  | RuntimeResourceValue;

export type RuntimeStateV1 = {
  schemaVersion: "1.0";
  values: Record<DefinitionId, RuntimeStoredValue>;
  entries: Record<string, CharacterEntryV1>;
};

export type RuntimeIntent =
  | {kind:"push";parent:NormalizedRoll;context:PushContext;executionId:string;optionsOnly?:boolean}
  | { kind: "initialize"; values?: Record<DefinitionId, unknown> }
  | { kind: "observe" }
  | { kind: "set"; fieldId: DefinitionId; value: unknown }
  | { kind: "bump"; resourceId: DefinitionId; direction: "up" | "down" }
  /** Design 6.3: apply an amount; the result is clamped to the resource's bounds. */
  | { kind: "adjust"; resourceId: DefinitionId; delta: unknown }
  /** Design 6.3: direct input of the current value and/or the character's maximum. */
  | { kind: "setResource"; resourceId: DefinitionId; current?: unknown; max?: unknown }
  | {
      kind: "action";
      actionId: DefinitionId;
      inputs: Record<DefinitionId, unknown>;
      executionId: CommandExecutionId;
      /**
       * Task 5: template-granted actions execute against the named character
       * entry. Absent = entity action (unchanged path). Entry commands
       * (add/remove/edit) belong to Task 7; only execution wires through here.
       */
      entryId?: string;
    };

export type RuntimeRequest = {
  versionId: VersionId;
  /** Design 6.8: extension versions the character is built on (none = base only). */
  extensions?: readonly ExtensionRef[];
  entityId: DefinitionId;
  state?: RuntimeStateV1;
  intent: RuntimeIntent;
};

export type RuntimeValidation = {
  validationId: DefinitionId;
  severity: "error" | "warning";
  message: string;
  targetDefinitionId: DefinitionId;
};

export type NormalizedDie = DieResult;

export type NormalizedRollBinding = {
  scope: "fields" | "inputs" | "item" | "aggregates";
  definitionId: DefinitionId;
  value: BindingValue;
};

/**
 * Roll visibility vocabulary shared by storage, DTOs and policy (I6 Task 8).
 * The Runtime itself is a rules evaluator, never a campaign policy engine:
 * it always stamps freshly evaluated rolls `owner_only`, and the Characters
 * module composes the authorized campaign audience after resolution.
 */
export type NormalizedRollAudience = "owner_only" | "gm_only" | "campaign";

export type NormalizedRoll = {
  push?: import("./implementation/rules/result.js").PushResult;
  breakdown: RollBreakdown;
  actionId: DefinitionId;
  expression: string;
  dice: NormalizedDie[];
  bindings: NormalizedRollBinding[];
  total: number;
  output: string;
  audience: NormalizedRollAudience;
};

/**
 * Task 5: activity-only outcome of a nominal template-granted action
 * (template action flagged `nominal: true`). No evaluation, no state change,
 * no roll — the caller records activity and surfaces `output` as display
 * text. Consumed by Task 7 (entry commands + sheet UI).
 */
export type NominalActionResult = {
  actionId: DefinitionId;
  entryId: string;
  output: string;
};

export type CharacterProjectionChoice = {
  id: DefinitionId;
  label: string;
};

export type CharacterProjectionFieldConstraints = {
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  maxLength?: number;
  options?: CharacterProjectionChoice[];
};

export type CharacterProjectionActionInput = {
  id: DefinitionId;
  label: string;
  valueType: "integer" | "decimal" | "boolean" | "text";
  required: boolean;
  default: RuntimeScalar;
};

export type CharacterProjectionElement =
  | {
      kind: "heading";
      id: DefinitionId;
      text: string;
      level: 2 | 3;
    }
  | {
      kind: "field";
      id: DefinitionId;
      fieldId: DefinitionId;
      label: string;
      fieldKind:
        | "text"
        | "integer"
        | "decimal"
        | "boolean"
        | "singleChoice"
        | "multiChoice"
        | "computed"
        | "image";
      value: RuntimeScalar | DefinitionId[];
      editable: boolean;
      constraints: CharacterProjectionFieldConstraints;
      validations: RuntimeValidation[];
    }
  | {
      kind: "resource";
      id: DefinitionId;
      resourceId: DefinitionId;
      label: string;
      value: RuntimeResourceValue;
      min: number;
      max: number;
      step: number;
      resetTo: "min" | "max";
      computedMaximum?: boolean;
      validations: RuntimeValidation[];
    }
  | {
      kind: "action";
      id: DefinitionId;
      actionId: DefinitionId;
      label: string;
      actionKind: "roll" | "resourceBump";
      inputs: CharacterProjectionActionInput[];
      validations: RuntimeValidation[];
      /**
       * Task 5: set on synthetic granted-action elements projected after
       * their entry inside a slot. Absent = sheet-placed entity action.
       */
      entryId?: string;
    }
  | {
      kind: "slot";
      id: DefinitionId;
      slotId: DefinitionId;
      label: string;
      accepts: TemplateKind[];
      entries: CharacterProjectionSlotEntry[];
    };

export type CharacterProjectionSlotEntry = {
  source?: import("./implementation/package/schema/dynamic.js").EntrySource;
  definition?: {
    id:string;label:string;kind:TemplateKind;
    fields:Array<CharacterProjectionFieldConstraints & {id:string;label:string;kind:Exclude<import("./implementation/package/schema/index.js").FieldV1["kind"],"computed"|"image">;default:unknown}>;
    grantedActions:Array<{id:string;label:string;kind:"roll"|"resourceBump";inputs:CharacterProjectionActionInput[]}>;
  };
  metadata?: {name:string;description?:string;notes?:string};
  entryId: string;
  templateId: DefinitionId | null;
  /** Design 6.8: extension of the entry's template; absent for base templates. */
  extensionId?: string;
  label: string;
  values: Record<string, unknown>;
  quantity?: number;
};

export type CharacterProjectionSection = {
  id: DefinitionId;
  label: string;
  elements: CharacterProjectionElement[];
};

export type CharacterProjectionSheet = {
  id: DefinitionId;
  label: string;
  sections: CharacterProjectionSection[];
};

export type CharacterProjectionV1 = {
  presentation?: import("./implementation/package/schema/index.js").SystemPresentation;
  projectionVersion: "1.0";
  systemId: string;
  versionId: VersionId;
  packageChecksum: string;
  entityId: DefinitionId;
  entityLabel: string;
  sheets: CharacterProjectionSheet[];
  completionFields?: Extract<CharacterProjectionElement, { kind: "field" }>[];
  derivedValues: Record<DefinitionId, RuntimeScalar>;
  validations: RuntimeValidation[];
};

export type RuntimeResolution = {
  pushContext?: PushContext;
  versionId: VersionId;
  packageChecksum: string;
  state: RuntimeStateV1;
  derivedValues: Record<DefinitionId, RuntimeScalar>;
  validations: RuntimeValidation[];
  changedDefinitionIds: DefinitionId[];
  roll: NormalizedRoll | null;
  nominal: NominalActionResult | null;
  projection: CharacterProjectionV1;
};

export type RuntimeErrorCode =
  | "bad_request"
  | "not_found"
  | "invalid_package"
  | "invalid_state"
  | "unsupported_field_value"
  | "push_unavailable"
  | "action_evaluation_failed"
  | "budget_exceeded"
  | "internal";

export type ActionEvaluationDiagnostic = {
  code: "arithmetic_failure";
  actionId: DefinitionId;
  expressionId: DefinitionId;
  message: string;
};

export type RuntimeError = {
  pushReason?: string;
  code: RuntimeErrorCode;
  message: string;
  definitionId?: DefinitionId;
  actionDiagnostics?: ActionEvaluationDiagnostic[];
};

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeError };

export type VersionDescription = {
  versionId: VersionId;
  packageChecksum: string;
  entities: {
    id: DefinitionId;
    label: string;
    kind: "playable" | "npc";
    fields?: Exclude<FieldV1, { kind: "computed" | "image" }>[];
    slots?: SlotDefinitionV1[];
  }[];
  /** Base templates first; extension templates carry their plain `id` plus `extensionId`. */
  templates?: Array<Pick<ObjectTemplateV1, "id" | "label" | "kind" | "description" | "fields"> & { extensionId?: string }>;
};

export interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<RuntimeResult<RuntimeResolution>>;
  describeVersion(input: {
    versionId: VersionId;
    extensions?: readonly ExtensionRef[];
    includeFields?: boolean;
  }): Promise<RuntimeResult<VersionDescription>>;
  /** Design 6.7 dry run: verify a stored state against another version of its system. */
  checkVersionChange(input: {
    fromVersionId: VersionId;
    toVersionId: VersionId;
    entityId: DefinitionId;
    state: unknown;
    direction: VersionChangeDirection;
  }): Promise<RuntimeResult<VersionChangeReport>>;
}

export function createSystemRuntime(input: {
  loadPackage: PublishedPackageLoader;
  /** Design 6.8: required to resolve characters built with extensions. */
  loadExtensionPackage?: PublishedExtensionLoader;
  authoritativeRollSecret: string;
}): SystemRuntime {
  if (Buffer.byteLength(input.authoritativeRollSecret, "utf8") < 32) {
    throw new Error("Authoritative roll secret must be at least 32 UTF-8 bytes.");
  }
  const loadEffective = createEffectivePackageLoader({
    loadPackage: input.loadPackage,
    ...(input.loadExtensionPackage === undefined ? {} : { loadExtensionPackage: input.loadExtensionPackage }),
  });

  return {
    async checkVersionChange(checkInput) {
      const from = await loadPublishedPackage(input.loadPackage, checkInput.fromVersionId);
      if (!from.ok) return from;
      const to = await loadPublishedPackage(input.loadPackage, checkInput.toVersionId);
      if (!to.ok) return to;
      return {
        ok: true,
        value: checkVersionChange({
          from: from.value,
          to: to.value,
          entityId: checkInput.entityId,
          state: checkInput.state,
          direction: checkInput.direction,
        }),
      };
    },

    async describeVersion(describeInput) {
      const loaded = await loadEffectivePackage(loadEffective, describeInput.versionId, describeInput.extensions);
      if (!loaded.ok) return loaded;
      return {
        ok: true,
        value: {
          versionId: loaded.value.versionId,
          packageChecksum: loaded.value.integrity.checksum,
          entities: loaded.value.entities.map((entity) => ({
            id: entity.id,
            label: entity.label,
            kind: entity.kind ?? "playable",
            ...(describeInput.includeFields ? {
              fields: entity.fields.filter((field) => field.kind !== "computed" && field.kind !== "image"),
              slots: slotsForEntity(loaded.value, entity.id),
            } : {}),
          })),
          ...(describeInput.includeFields ? {
            templates: loaded.value.templates.map(({ id, label, kind, description, fields }) => {
              const key = unqualifiedId(id);
              return {
                id: key.id, label, kind, fields,
                ...(key.origin === null ? {} : { extensionId: key.origin }),
                ...(description === undefined ? {} : { description }),
              };
            }),
          } : {}),
        },
      };
    },

    async resolve(request) {
      const loaded = await loadEffectivePackage(loadEffective, request.versionId, request.extensions);
      if (!loaded.ok) return loaded;
      const packageValue = loaded.value;

      const entity = packageValue.entities.find((candidate) => candidate.id === request.entityId);
      if (entity === undefined) {
        return { ok: false, error: { code: "not_found", message: "Entity definition not found." } };
      }

      let stateResult: RuntimeResult<RuntimeStateV1>;
      let changedDefinitionIds: DefinitionId[] = [];
      let pendingRoll: {
        actionId: DefinitionId;
        expressionId: DefinitionId;
        inputs: Record<DefinitionId, RuntimeScalar>;
        executionId: CommandExecutionId;
        outputTemplate: string;
        action: Extract<SystemPackageV1["actions"][number],{kind:"roll"}>;
      } | null = null;
      let roll: NormalizedRoll | null = null;
      let nominal: NominalActionResult | null = null;
      let pushContext: PushContext | undefined;
      if (request.intent.kind === "initialize") {
        if (request.state !== undefined) {
          return { ok: false, error: { code: "bad_request", message: "Initialize does not accept existing state." } };
        }
        stateResult = initializeState(entity, request.intent.values);
      } else if (request.intent.kind === "observe") {
        if (request.state === undefined) {
          return { ok: false, error: { code: "bad_request", message: "Observe requires state." } };
        }
        stateResult = decodeRuntimeState(entity, request.state);
      } else {
        if (request.state === undefined) {
          return { ok: false, error: { code: "bad_request", message: "Runtime command requires state." } };
        }
        stateResult = decodeRuntimeState(entity, request.state);
        if (!stateResult.ok) return stateResult;

        if(request.intent.kind==="push"){
          const pushed=resolveRuntimePush({pkg:packageValue,entity,state:stateResult.value,parent:request.intent.parent,context:request.intent.context,executionId:request.intent.executionId,secret:input.authoritativeRollSecret,...(request.intent.optionsOnly?{optionsOnly:true}:{})});
          if(!pushed.ok)return pushed;roll=pushed.value.roll;pushContext=pushed.value.context;
        } else if (request.intent.kind === "set") {
          const fieldId = request.intent.fieldId;
          const field = entity.fields.find((candidate) => candidate.id === fieldId);
          if (field === undefined || field.kind === "computed" || field.kind === "resource") {
            return badRequest("Field is not editable.", request.intent.fieldId);
          }
          if (field.kind === "image" && request.intent.value !== null) {
            return unsupportedImage(field.id);
          }
          const nextState = structuredClone(stateResult.value);
          nextState.values[field.id] = request.intent.value as RuntimeStoredValue;
          const decoded = decodeRuntimeState(entity, nextState);
          if (!decoded.ok) return badRequest("Field value is invalid.", field.id);
          changedDefinitionIds = sameValue(stateResult.value.values[field.id]!, decoded.value.values[field.id]!)
            ? []
            : [field.id];
          stateResult = decoded;
        } else if (request.intent.kind === "bump") {
          const bumped = changeResource(
            entity,
            stateResult.value,
            request.intent.resourceId,
            request.intent.direction === "up" ? 1 : -1,
          );
          if (!bumped.ok) return bumped;
          stateResult = { ok: true, value: bumped.value };
          changedDefinitionIds = [request.intent.resourceId];
        } else if (request.intent.kind === "adjust" || request.intent.kind === "setResource") {
          const edited = request.intent.kind === "adjust"
            ? adjustResource(entity, stateResult.value, request.intent.resourceId, request.intent.delta)
            : setResource(entity, stateResult.value, request.intent.resourceId, request.intent);
          if (!edited.ok) return edited;
          changedDefinitionIds = sameValue(
            stateResult.value.values[request.intent.resourceId]!,
            edited.value.values[request.intent.resourceId]!,
          ) ? [] : [request.intent.resourceId];
          stateResult = { ok: true, value: edited.value };
        } else if (request.intent.kind === "action" && request.intent.entryId !== undefined) {
          const granted = resolveGrantedAction({
            packageValue,
            entity,
            state: stateResult.value,
            entryId: request.intent.entryId,
            actionId: request.intent.actionId,
            inputs: request.intent.inputs,
            executionId: request.intent.executionId,
            authoritativeRollSecret: input.authoritativeRollSecret,
          });
          if (!granted.ok) return granted;
          stateResult = { ok: true, value: granted.value.state };
          changedDefinitionIds = granted.value.changedDefinitionIds;
          roll = granted.value.roll;
          nominal = granted.value.nominal;
          pushContext = granted.value.pushContext;
        } else {
          const action = findOwnedAction(packageValue, entity.id, request.intent.actionId);
          if (action === undefined) return badRequest("Action does not belong to the entity.", request.intent.actionId);
          if (action.kind === "resourceBump") {
            if (Object.keys(request.intent.inputs).length > 0) {
              const definitionId = Object.keys(request.intent.inputs)[0]!;
              return badRequest("Resource actions do not accept inputs.", definitionId);
            }
            const resource = entity.fields.find((field) => field.id === action.resourceId);
            if (resource?.kind !== "resource") return invalidPackage(action.resourceId);
            const current = stateResult.value.values[resource.id] as RuntimeResourceValue;
            const target = action.operation.kind === "reset"
              ? resource.resetTo === "max" ? current.max : resource.min
              : current.current + action.operation.amount;
            const changed = target !== current.current;
            const nextState = structuredClone(stateResult.value);
            nextState.values[resource.id] = { current: target, max: current.max };
            const decoded = decodeRuntimeState(entity, nextState);
            if (!decoded.ok) return badRequest("Resource action exceeds its bounds.", resource.id);
            stateResult = decoded;
            changedDefinitionIds = changed ? [resource.id] : [];
          } else {
            const actionInputs = decodeActionInputs(action.inputs, request.intent.inputs);
            if (!actionInputs.ok) return actionInputs;
            pendingRoll = {
              action,
              actionId: action.id,
              expressionId: action.expressionId,
              inputs: actionInputs.value,
              executionId: request.intent.executionId,
              outputTemplate: action.outputTemplate,
            };
          }
        }
      }
      if (!stateResult.ok) return stateResult;

      for(const entry of Object.values(stateResult.value.entries)) {
        const siblings=Object.values(stateResult.value.entries).filter(e=>e.slotId===entry.slotId && e.entryId!==entry.entryId).length;
        const error=derivedEntryError(packageValue,entity,entry,siblings);
        if(error) return {ok:false,error:{code:"invalid_state",message:error}};
      }
      const observed = resolveObservedValues(packageValue, entity, stateResult.value);
      if (!observed.ok) return observed;
      const observedState = observed.value.state;
      for (const field of entity.fields) {
        if (field.kind === "resource" && field.maxExpressionId !== undefined
          && !sameValue(stateResult.value.values[field.id]!, observedState.values[field.id]!)
          && !changedDefinitionIds.includes(field.id)) {
          changedDefinitionIds.push(field.id);
        }
      }
      stateResult = { ok: true, value: observedState };
      if (pendingRoll !== null) {
        const expression = packageValue.expressions.find((candidate) => candidate.id === pendingRoll.expressionId);
        if (expression === undefined || expression.context !== "roll") return invalidPackage(pendingRoll.expressionId);
        const bindings = characterRuleBindings(packageValue, entity, stateResult.value);
        Object.assign(bindings.fields, observed.value.derivedValues);
        bindings.inputs = pendingRoll.inputs;
        const evaluated = evaluate(
          expression,
          bindings,
          createDeterministicRng(input.authoritativeRollSecret, pendingRoll.executionId),
          packageValue.effectiveLimits,
        );
        if (!evaluated.ok) {
          return evaluated.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded")
            ? budgetExceeded()
            : invalidPackage(expression.id);
        }
        const failure = actionEvaluationFailure(evaluated, pendingRoll.actionId, expression.id);
        if (failure !== null) return { ok: false, error: failure };
        if (evaluated.roll === null) return invalidPackage(expression.id);
        pushContext=makePushContext(packageValue,entity.id,pendingRoll.action);
        roll = {
          actionId: pendingRoll.actionId,
          expression: evaluated.roll.expression,
          dice: evaluated.roll.dice,
          breakdown: evaluated.roll.breakdown,
          bindings: evaluated.bindings,
          total: evaluated.roll.total,
          output: pendingRoll.outputTemplate.split("{total}").join(String(evaluated.roll.total)),
          audience: "owner_only",
        };
      }
      const projection = buildCharacterProjection({
        packageValue,
        entity,
        state: stateResult.value,
        derivedValues: observed.value.derivedValues,
        validations: observed.value.validations,
      });
      return {
        ok: true,
        value: {
          versionId: packageValue.versionId,
          packageChecksum: packageValue.integrity.checksum,
          state: stateResult.value,
          derivedValues: observed.value.derivedValues,
          validations: observed.value.validations,
          changedDefinitionIds,
          roll,
          nominal,
          ...(pushContext?{pushContext}:{}),
          projection,
        },
      };
    },
  };
}

async function loadEffectivePackage(
  loadEffective: EffectivePackageLoader,
  versionId: VersionId,
  extensions: readonly ExtensionRef[] | undefined,
): Promise<RuntimeResult<SystemPackageV1>> {
  const loaded = await loadEffective(versionId, extensions);
  return loaded.ok ? loaded : { ok: false, error: { code: loaded.error.code, message: loaded.error.message } };
}

async function loadPublishedPackage(
  loadPackage: PublishedPackageLoader,
  versionId: VersionId,
): Promise<RuntimeResult<SystemPackageV1>> {
  let packageValue;
  try {
    packageValue = await loadPackage(versionId);
  } catch (error) {
    if (error instanceof PublishedPackageCorruptError) {
      return {
        ok: false,
        error: { code: "invalid_package", message: "Published package is corrupt." },
      };
    }
    return { ok: false, error: { code: "internal", message: "Package loading failed." } };
  }
  if (packageValue === null) {
    return { ok: false, error: { code: "not_found", message: "Published version not found." } };
  }
  if (packageValue.versionId !== versionId) {
    return {
      ok: false,
      error: { code: "invalid_package", message: "Published package version differs from the request." },
    };
  }
  return { ok: true, value: packageValue };
}

function changeResource(
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  resourceId: string,
  direction: 1 | -1,
): RuntimeResult<RuntimeStateV1> {
  const resource = entity.fields.find((field) => field.id === resourceId);
  if (resource?.kind !== "resource") return badRequest("Resource does not belong to the entity.", resourceId);
  const current = state.values[resource.id] as RuntimeResourceValue;
  const nextState = structuredClone(state);
  nextState.values[resource.id] = {
    current: current.current + direction * resource.step,
    max: current.max,
  };
  const decoded = decodeRuntimeState(entity, nextState);
  return decoded.ok ? decoded : badRequest("Resource bump exceeds its bounds.", resource.id);
}

function resourceOf(entity: EntityDefinitionV1, state: RuntimeStateV1, resourceId: string) {
  const resource = entity.fields.find((field) => field.id === resourceId);
  if (resource?.kind !== "resource") return undefined;
  return { resource, value: state.values[resource.id] as RuntimeResourceValue };
}

function withResource(
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  resourceId: string,
  value: RuntimeResourceValue,
): RuntimeResult<RuntimeStateV1> {
  const nextState = structuredClone(state);
  nextState.values[resourceId] = value;
  const decoded = decodeRuntimeState(entity, nextState);
  return decoded.ok ? decoded : badRequest("Resource value is outside its bounds or step.", resourceId);
}

/** Applies an amount such as damage or healing; the result stops at the minimum and the stored maximum. */
function adjustResource(
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  resourceId: string,
  delta: unknown,
): RuntimeResult<RuntimeStateV1> {
  const owned = resourceOf(entity, state, resourceId);
  if (owned === undefined) return badRequest("Resource does not belong to the entity.", resourceId);
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) {
    return badRequest("Resource amount must be a non-zero number.", resourceId);
  }
  const steps = delta / owned.resource.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    return badRequest("Resource amount must be a multiple of the resource's step.", resourceId);
  }
  const current = Math.max(owned.resource.min, Math.min(owned.value.max, owned.value.current + delta));
  return withResource(entity, state, resourceId, { current, max: owned.value.max });
}

/** Sets current and/or maximum. Lowering the maximum alone lowers a higher current value with it. */
function setResource(
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
  resourceId: string,
  input: { current?: unknown; max?: unknown },
): RuntimeResult<RuntimeStateV1> {
  const owned = resourceOf(entity, state, resourceId);
  if (owned === undefined) return badRequest("Resource does not belong to the entity.", resourceId);
  if (owned.resource.maxExpressionId !== undefined && input.max !== undefined) {
    return badRequest("This resource maximum is calculated by the rules.", resourceId);
  }
  if (input.current === undefined && input.max === undefined) {
    return badRequest("Provide a current value, a maximum, or both.", resourceId);
  }
  for (const value of [input.current, input.max]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      return badRequest("Resource values must be numbers.", resourceId);
    }
  }
  const max = (input.max as number | undefined) ?? owned.value.max;
  const current = (input.current as number | undefined) ?? Math.min(owned.value.current, max);
  return withResource(entity, state, resourceId, { current, max });
}

function sameValue(left: RuntimeStoredValue, right: RuntimeStoredValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function badRequest(message: string, definitionId?: string): RuntimeResult<never> {
  return {
    ok: false,
    error: { code: "bad_request", message, ...(definitionId === undefined ? {} : { definitionId }) },
  };
}

function unsupportedImage(definitionId: string): RuntimeResult<never> {
  return {
    ok: false,
    error: {
      code: "unsupported_field_value",
      message: "Image field values are not supported.",
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
