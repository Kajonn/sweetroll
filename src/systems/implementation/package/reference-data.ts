import type { PackageDiagnostic } from "./diagnostics.js";
import type { FieldV1, ReferenceDataV1 } from "./schema/index.js";

export function validateDataset(dataset: ReferenceDataV1, path: string): PackageDiagnostic[] {
  if (dataset.keyColumn === undefined && dataset.columns === undefined) return [];
  const { keyColumn, columns } = dataset;
  const fail = (location: string, message: string): PackageDiagnostic => ({
    code: "invalid_schema", path: path + location, message,
  });
  if (keyColumn === undefined || columns === undefined || !Object.hasOwn(columns, keyColumn)) {
    return [fail("/keyColumn", "A typed dataset must name one of its declared columns as its key.")];
  }
  const diagnostics: PackageDiagnostic[] = [];
  const keys = new Set<unknown>();
  for (const [index, record] of dataset.records.entries()) {
    const row = `/records/${index}/values`;
    for (const [column, type] of Object.entries(columns)) {
      const value = Object.hasOwn(record.values, column) ? record.values[column] : undefined;
      if (typeof value !== (type === "text" ? "string" : type)
        || (typeof value === "number" && !Number.isFinite(value))) {
        diagnostics.push(fail(`${row}/${column}`, `Column "${column}" must contain a ${type} value.`));
      }
    }
    for (const column of Object.keys(record.values)) {
      if (!Object.hasOwn(columns, column)) diagnostics.push(fail(`${row}/${column}`, "Dataset column is not declared."));
    }
    const key = record.values[keyColumn];
    if (keys.has(key)) diagnostics.push(fail(`${row}/${keyColumn}`, "Dataset keys must be unique."));
    keys.add(key);
  }
  return diagnostics;
}

export function fieldWithDatasetOptions(field: FieldV1, datasets: readonly ReferenceDataV1[]): FieldV1 {
  if ((field.kind !== "singleChoice" && field.kind !== "multiChoice") || field.optionsFrom === undefined) return field;
  const dataset = datasets.find(candidate => candidate.id === field.optionsFrom);
  return dataset === undefined ? field : {
    ...field,
    options: dataset.records.map(({ id, label }) => ({ id, label })),
  };
}
