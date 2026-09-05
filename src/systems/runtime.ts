import { PublishedPackageCorruptError, type PublishedPackageLoader } from "./implementation/runtime/package-loader.js";
import { buildCharacterProjection } from "./implementation/runtime/projection.js";
import { resolveObservedValues } from "./implementation/runtime/resolve.js";
import { decodeRuntimeState, initializeState } from "./implementation/runtime/state.js";

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

export type NormalizedRoll = {
  actionId: DefinitionId;
  expression: string;
  dice: NormalizedDie[];
  bindings: NormalizedRollBinding[];
  total: number;
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

export interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<RuntimeResult<RuntimeResolution>>;
}

export function createSystemRuntime(input: {
  loadPackage: PublishedPackageLoader;
  authoritativeRollSecret: string;
}): SystemRuntime {
  if (input.authoritativeRollSecret.length === 0) {
    throw new Error("Authoritative roll secret must not be empty.");
  }

  return {
    async resolve(request) {
      let packageValue;
      try {
        packageValue = await input.loadPackage(request.versionId);
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
      if (packageValue.versionId !== request.versionId) {
        return { ok: false, error: { code: "invalid_package", message: "Published package version differs from the request." } };
      }

      const entity = packageValue.entities.find((candidate) => candidate.id === request.entityId);
      if (entity === undefined) {
        return { ok: false, error: { code: "not_found", message: "Entity definition not found." } };
      }

      let stateResult: RuntimeResult<RuntimeStateV1>;
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
        return { ok: false, error: { code: "bad_request", message: "Runtime intent is not implemented." } };
      }
      if (!stateResult.ok) return stateResult;

      const observed = resolveObservedValues(packageValue, entity, stateResult.value);
      if (!observed.ok) return observed;
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
          changedDefinitionIds: [],
          roll: null,
          projection,
        },
      };
    },
  };
}
