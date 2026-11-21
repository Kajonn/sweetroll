import type { EntityDefinitionV1, ReferenceDataV1 } from "../package/schema/index.js";

/**
 * Design 6.1 (SRD gaps S3): an entity's presets are the rows of a dataset.
 * A row's values are keyed by field ID; a number fills a resource's current
 * value and maximum. Returns a problem for publication, or null.
 */
export function presetProblem(entity: EntityDefinitionV1, datasets: readonly ReferenceDataV1[]): string | null {
  if (entity.presetsFrom === undefined) return null;
  const dataset = datasets.find((candidate) => candidate.id === entity.presetsFrom);
  if (dataset === undefined) return "Select an existing dataset for the presets.";
  const fields = new Map(entity.fields.map((field) => [field.id, field]));
  for (const record of dataset.records) {
    for (const [fieldId, value] of Object.entries(record.values)) {
      const field = fields.get(fieldId);
      if (field === undefined || field.kind === "computed" || field.kind === "image" || field.kind === "multiChoice") {
        return `Preset "${record.id}" sets "${fieldId}", which is not a stored text, number, true/false, choice or resource field of "${entity.id}".`;
      }
      if (value === null) continue;
      const expected = field.kind === "boolean" ? "boolean" : field.kind === "text" || field.kind === "singleChoice" ? "string" : "number";
      if (typeof value !== expected) return `Preset "${record.id}" gives "${fieldId}" a ${typeof value}; it needs a ${expected}.`;
    }
  }
  return null;
}

/** The initial values a preset gives; null when the entity has no such preset. */
export function presetValues(
  entity: EntityDefinitionV1,
  datasets: readonly ReferenceDataV1[],
  presetId: string,
): Record<string, unknown> | null {
  const record = datasets.find((candidate) => candidate.id === entity.presetsFrom)?.records.find((candidate) => candidate.id === presetId);
  if (entity.presetsFrom === undefined || record === undefined) return null;
  const values: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(record.values)) {
    if (value === null) continue;
    const field = entity.fields.find((candidate) => candidate.id === fieldId);
    values[fieldId] = field?.kind === "resource" ? { current: value, max: value } : value;
  }
  return values;
}

export function presetOptions(entity: EntityDefinitionV1, datasets: readonly ReferenceDataV1[]): Array<{ id: string; label: string }> | undefined {
  const dataset = datasets.find((candidate) => candidate.id === entity.presetsFrom);
  return dataset?.records.map(({ id, label }) => ({ id, label }));
}
