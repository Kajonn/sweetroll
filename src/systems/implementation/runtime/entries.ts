import type {
  CharacterEntryV1,
  FieldV1,
  ObjectTemplateV1,
  SlotDefinitionV1,
} from "../package/schema/index.js";

export const DEFAULT_SLOT_MAX_ENTRIES = 50;

export type EntryValidationCode =
  | "unknown_slot"
  | "kind_not_accepted"
  | "custom_entry_with_actions"
  | "entry_values_invalid"
  | "slot_full";

export type EntryValidationResult =
  | { ok: true }
  | {
    ok: false;
    code: EntryValidationCode;
    message: string;
    definitionId?: string;
  };

export function validateEntryForSlot(
  entry: CharacterEntryV1,
  slots: SlotDefinitionV1[],
  templates: ObjectTemplateV1[],
  siblingCount: number,
): EntryValidationResult {
  if (!isRecord(entry.values)) {
    return invalid("entry_values_invalid", "Entry values must be an object.");
  }
  const slot = slots.find((candidate) => candidate.id === entry.slotId);
  if (slot === undefined) {
    return invalid("unknown_slot", "Entry slot is unknown.", entry.slotId);
  }
  const capacity = slot.maxEntries ?? DEFAULT_SLOT_MAX_ENTRIES;
  if (Math.max(0, siblingCount) >= capacity) {
    return invalid("slot_full", "Slot has reached its maximum entries.", slot.id);
  }
  if (entry.templateId === null) {
    if (
      Object.hasOwn(entry.values, "actions")
      || Object.hasOwn(entry.values, "grantedActions")
    ) {
      return invalid(
        "custom_entry_with_actions",
        "Custom entries are data-only and cannot carry granted actions.",
      );
    }
    return { ok: true };
  }
  const template = templates.find((candidate) => candidate.id === entry.templateId);
  if (template === undefined) {
    return invalid("entry_values_invalid", "Entry template is unknown.");
  }
  if (!slot.accepts.some((kind) => kind === template.kind)) {
    return invalid(
      "kind_not_accepted",
      "Template kind is not accepted by the slot.",
      template.id,
    );
  }
  const fields = new Map(template.fields.map((field) => [field.id, field]));
  for (const id of Object.keys(entry.values)) {
    const field = fields.get(id);
    if (field === undefined) {
      return invalid("entry_values_invalid", "Entry value is not a template field.", id);
    }
    if (!validEntryValue(field, entry.values[id])) {
      return invalid("entry_values_invalid", "Entry value violates its template field type.", id);
    }
  }
  return { ok: true };
}

export function buildEntryScope(
  characterFields: Record<string, unknown>,
  entryValues: Record<string, unknown>,
): Record<string, unknown> {
  return { ...characterFields, ...entryValues };
}

function validEntryValue(field: FieldV1, value: unknown): boolean {
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string") return false;
      if (field.required && value.length === 0) return true;
      return value.length >= field.minLength && value.length <= field.maxLength;
    }
    case "integer":
      return Number.isInteger(value) && validNumber(field, value as number);
    case "decimal":
      return typeof value === "number" && validNumber(field, value);
    case "boolean":
      return typeof value === "boolean";
    case "singleChoice":
      return value === null
        || (typeof value === "string" && field.options.some((option) => option.id === value));
    case "multiChoice": {
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return false;
      const ids = value as string[];
      const options = new Set(field.options.map((option) => option.id));
      return new Set(ids).size === ids.length && ids.every((id) => options.has(id));
    }
    case "resource": {
      if (!isRecord(value)) return false;
      const { current, max } = value as { current: unknown; max: unknown };
      return typeof current === "number"
        && typeof max === "number"
        && Number.isFinite(current)
        && Number.isFinite(max)
        && (max as number) >= field.min
        && (max as number) <= field.max
        && (current as number) >= field.min
        && (current as number) <= (max as number)
        && onStep(current as number, field.min, field.step)
        && onStep(max as number, field.min, field.step);
    }
    case "computed":
    case "image":
      return false;
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

function invalid(
  code: EntryValidationCode,
  message: string,
  definitionId?: string,
): EntryValidationResult {
  return {
    ok: false,
    code,
    message,
    ...(definitionId === undefined ? {} : { definitionId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
