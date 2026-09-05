import type {
  RuntimeResourceValue,
  RuntimeResult,
  RuntimeStateV1,
  RuntimeStoredValue,
} from "../../runtime.js";
import type { EntityDefinitionV1, FieldV1, ScalarValue } from "../package/schema/index.js";

export function initializeState(
  entity: EntityDefinitionV1,
  values: Record<string, unknown> = {},
): RuntimeResult<RuntimeStateV1> {
  if (!isRecord(values)) return invalidState("Initial values must be an object.");

  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  for (const id of Object.keys(values)) {
    const field = fields.get(id);
    if (field === undefined || field.kind === "computed") {
      return invalidState("Initial values contain an unknown or computed field.", id);
    }
  }

  const stored: Record<string, RuntimeStoredValue> = {};
  for (const field of entity.fields) {
    if (field.kind === "computed") continue;
    const supplied = Object.hasOwn(values, field.id);
    const value = supplied
      ? values[field.id]
      : field.kind === "image"
        ? null
        : structuredClone(field.default);
    const decoded = decodeFieldValue(field, value, supplied);
    if (!decoded.ok) return decoded;
    stored[field.id] = decoded.value;
  }
  return { ok: true, value: { schemaVersion: "1.0", values: stored } };
}

export function decodeRuntimeState(
  entity: EntityDefinitionV1,
  input: unknown,
): RuntimeResult<RuntimeStateV1> {
  if (
    !isRecord(input)
    || Object.keys(input).length !== 2
    || input.schemaVersion !== "1.0"
    || !isRecord(input.values)
  ) {
    return invalidState("State does not match runtime schema version 1.0.");
  }

  const stateValues = input.values;
  const expected = entity.fields.filter((field) => field.kind !== "computed");
  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  for (const id of Object.keys(stateValues)) {
    const field = fields.get(id);
    if (field === undefined || field.kind === "computed") {
      return invalidState("State contains an unknown or computed field.", id);
    }
  }
  if (expected.some((field) => !Object.hasOwn(stateValues, field.id))) {
    return invalidState("State is missing a stored field.");
  }

  const values: Record<string, RuntimeStoredValue> = {};
  for (const field of expected) {
    const decoded = decodeFieldValue(field, stateValues[field.id], false);
    if (!decoded.ok) return decoded;
    values[field.id] = decoded.value;
  }
  return { ok: true, value: { schemaVersion: "1.0", values } };
}

export function buildFieldBindings(
  entity: EntityDefinitionV1,
  state: RuntimeStateV1,
): Record<string, ScalarValue> {
  const bindings: Record<string, ScalarValue> = {};
  for (const field of entity.fields) {
    if (field.kind === "computed") continue;
    const value = state.values[field.id];
    if (field.kind === "resource") {
      bindings[field.id] = (value as RuntimeResourceValue).current;
    } else if (Array.isArray(value)) {
      bindings[field.id] = value.length === 0 ? null : value.join(",");
    } else {
      bindings[field.id] = value as ScalarValue;
    }
  }
  return bindings;
}

function decodeFieldValue(
  field: Exclude<FieldV1, { kind: "computed" }>,
  value: unknown,
  initializing: boolean,
): RuntimeResult<RuntimeStoredValue> {
  switch (field.kind) {
    case "text":
      if (
        typeof value !== "string"
        || (!(field.required && value.length === 0)
          && (value.length < field.minLength || value.length > field.maxLength))
      ) return invalidField(field.id);
      return { ok: true, value };
    case "integer":
      if (!Number.isInteger(value) || !validNumber(field, value as number)) {
        return invalidField(field.id);
      }
      return { ok: true, value: value as number };
    case "decimal":
      if (typeof value !== "number" || !validNumber(field, value)) return invalidField(field.id);
      return { ok: true, value };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : invalidField(field.id);
    case "singleChoice":
      if (value !== null && (typeof value !== "string" || !field.options.some((o) => o.id === value))) {
        return invalidField(field.id);
      }
      return { ok: true, value: value as string | null };
    case "multiChoice": {
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
        return invalidField(field.id);
      }
      const ids = value as string[];
      const options = new Set(field.options.map((option) => option.id));
      if (new Set(ids).size !== ids.length || ids.some((id) => !options.has(id))) {
        return invalidField(field.id);
      }
      return { ok: true, value: [...ids] };
    }
    case "resource":
      if (!isRecord(value) || Object.keys(value).length !== 2) return invalidField(field.id);
      if (
        typeof value.current !== "number"
        || typeof value.max !== "number"
        || !Number.isFinite(value.current)
        || !Number.isFinite(value.max)
        || value.max < field.min
        || value.max > field.max
        || value.current < field.min
        || value.current > value.max
        || !onStep(value.current, field.min, field.step)
        || !onStep(value.max, field.min, field.step)
      ) return invalidField(field.id);
      return { ok: true, value: { current: value.current, max: value.max } };
    case "image":
      if (value !== null) {
        return initializing
          ? {
              ok: false,
              error: {
                code: "unsupported_field_value",
                message: "Image field values are not supported.",
                definitionId: field.id,
              },
            }
          : invalidField(field.id);
      }
      return { ok: true, value: null };
  }
}

function validNumber(
  field: { min: number; max: number; step: number },
  value: number,
): boolean {
  return Number.isFinite(value)
    && value >= field.min
    && value <= field.max
    && onStep(value, field.min, field.step);
}

function onStep(value: number, min: number, step: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return false;
  const quotient = (value - min) / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function invalidField(definitionId: string): RuntimeResult<never> {
  return invalidState("State contains an invalid field value.", definitionId);
}

function invalidState(message: string, definitionId?: string): RuntimeResult<never> {
  return {
    ok: false,
    error: { code: "invalid_state", message, ...(definitionId === undefined ? {} : { definitionId }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
