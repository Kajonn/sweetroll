import { PublishedPackageCorruptError, type PublishedPackageLoader } from "./implementation/runtime/package-loader.js";
import { buildCharacterProjection } from "./implementation/runtime/projection.js";
import { decodeActionInputs, resolveGrantedAction } from "./implementation/runtime/resolve-entries.js";
import { resolveObservedValues } from "./implementation/runtime/resolve.js";
import { createDeterministicRng } from "./implementation/runtime/deterministic-rng.js";
import { buildFieldBindings, decodeRuntimeState, initializeState } from "./implementation/runtime/state.js";
import { evaluate } from "./implementation/rules/evaluate.js";
import type { CharacterEntryV1, EntityDefinitionV1, SystemPackageV1, TemplateKind } from "./implementation/package/schema/index.js";

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
  // Optional so legacy rows and hand-built states without entries keep
  // decoding; decodeRuntimeState/initializeState always normalize to present.
  entries?: Record<string, CharacterEntryV1>;
};

export type RuntimeIntent =
  | { kind: "initialize"; values?: Record<DefinitionId, unknown> }
  | { kind: "observe" }
  | { kind: "set"; fieldId: DefinitionId; value: unknown }
  | { kind: "bump"; resourceId: DefinitionId; direction: "up" | "down" }
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

export type NormalizedDie = {
  sides: number;
  value: number;
  kept: boolean;
};

export type NormalizedRollBinding = {
  scope: "fields" | "inputs";
  definitionId: DefinitionId;
  value: RuntimeScalar;
};

/**
 * Roll visibility vocabulary shared by storage, DTOs and policy (I6 Task 8).
 * The Runtime itself is a rules evaluator, never a campaign policy engine:
 * it always stamps freshly evaluated rolls `owner_only`, and the Characters
 * module composes the authorized campaign audience after resolution.
 */
export type NormalizedRollAudience = "owner_only" | "gm_only" | "campaign";

export type NormalizedRoll = {
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
  entryId: string;
  templateId: DefinitionId | null;
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
  | "budget_exceeded"
  | "internal";

export type RuntimeError = {
  code: RuntimeErrorCode;
  message: string;
  definitionId?: DefinitionId;
};

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeError };

export type VersionDescription = {
  versionId: VersionId;
  packageChecksum: string;
  entities: { id: DefinitionId; label: string; kind: "playable" | "npc" }[];
};

export interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<RuntimeResult<RuntimeResolution>>;
  describeVersion(input: { versionId: VersionId }): Promise<RuntimeResult<VersionDescription>>;
}

export function createSystemRuntime(input: {
  loadPackage: PublishedPackageLoader;
  authoritativeRollSecret: string;
}): SystemRuntime {
  if (Buffer.byteLength(input.authoritativeRollSecret, "utf8") < 32) {
    throw new Error("Authoritative roll secret must be at least 32 UTF-8 bytes.");
  }

  return {
    async describeVersion(describeInput) {
      const loaded = await loadPublishedPackage(input.loadPackage, describeInput.versionId);
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
          })),
        },
      };
    },

    async resolve(request) {
      const loaded = await loadPublishedPackage(input.loadPackage, request.versionId);
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
      } | null = null;
      let roll: NormalizedRoll | null = null;
      let nominal: NominalActionResult | null = null;
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

        if (request.intent.kind === "set") {
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

      const observed = resolveObservedValues(packageValue, entity, stateResult.value);
      if (!observed.ok) return observed;
      if (pendingRoll !== null) {
        const expression = packageValue.expressions.find((candidate) => candidate.id === pendingRoll.expressionId);
        if (expression === undefined || expression.context !== "roll") return invalidPackage(pendingRoll.expressionId);
        const fields = buildFieldBindings(entity, stateResult.value);
        Object.assign(fields, observed.value.derivedValues);
        const evaluated = evaluate(
          expression,
          { fields, inputs: pendingRoll.inputs },
          createDeterministicRng(input.authoritativeRollSecret, pendingRoll.executionId),
          packageValue.effectiveLimits,
        );
        if (!evaluated.ok) {
          return evaluated.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded")
            ? budgetExceeded()
            : invalidPackage(expression.id);
        }
        if (evaluated.roll === null) return invalidPackage(expression.id);
        roll = {
          actionId: pendingRoll.actionId,
          expression: evaluated.roll.expression,
          dice: evaluated.roll.dice,
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
          projection,
        },
      };
    },
  };
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

function findOwnedAction(packageValue: SystemPackageV1, entityId: string, actionId: string) {
  const owned = packageValue.sheets
    .filter((sheet) => sheet.targetEntityId === entityId)
    .some((sheet) => sheet.sections.some((section) =>
      section.elements.some((element) => element.kind === "action" && element.actionId === actionId)
    ));
  return owned ? packageValue.actions.find((action) => action.id === actionId) : undefined;
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
