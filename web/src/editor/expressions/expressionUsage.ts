export type ExpressionUsageKind = "field" | "action" | "validation";

export type ExpressionUsage = {
  kind: ExpressionUsageKind;
  /** Field label, action label, or validation message. */
  label: string;
  /** Entity label for fields, action/validation id otherwise. */
  detail: string;
};

type UsageDocument = {
  entities: ReadonlyArray<{
    id: string;
    label: string;
    fields: ReadonlyArray<Record<string, unknown>>;
  }>;
  actions: ReadonlyArray<Record<string, unknown>>;
  validations: ReadonlyArray<{
    id: string;
    expressionId: string;
    message: string;
  }>;
};

/** Every field/action/validation referencing an expression, for "used by" display. */
export function expressionUsages(
  document: UsageDocument,
  expressionId: string,
): ExpressionUsage[] {
  const out: ExpressionUsage[] = [];
  for (const entity of document.entities) {
    for (const field of entity.fields) {
      if (field["kind"] === "computed" && field["expressionId"] === expressionId) {
        out.push({
          kind: "field",
          label: String(field["label"] ?? field["id"] ?? expressionId),
          detail: entity.label,
        });
      }
    }
  }
  for (const action of document.actions) {
    if (action["expressionId"] === expressionId) {
      out.push({
        kind: "action",
        label: String(action["label"] ?? action["id"] ?? expressionId),
        detail: String(action["id"] ?? ""),
      });
    }
  }
  for (const validation of document.validations) {
    if (validation.expressionId === expressionId) {
      out.push({
        kind: "validation",
        label: validation.message || validation.id,
        detail: validation.id,
      });
    }
  }
  return out;
}
