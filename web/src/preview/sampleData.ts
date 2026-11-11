import { entityFieldTypes, resolveDependencies, type BindingValue, type RulesDataset, type SlotEnvironment } from "@sweetroll/rules";
import type {
  ExpressionAstV1,
  ScalarValue,
  ValueType,
} from "@sweetroll/rules";
import { renderExpression } from "@sweetroll/rules";

import { evaluateExpression } from "../ports/evaluateExpression.js";

export type DefinitionId = string;
export type EntityTypeId = DefinitionId;

export type ChoiceOptionV1 = {
  id: DefinitionId;
  label: string;
};

export type TextFieldV1 = {
  kind: "text";
  id: DefinitionId;
  label: string;
  default: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};

export type IntegerFieldV1 = {
  kind: "integer";
  id: DefinitionId;
  label: string;
  default: number;
  required: boolean;
  min: number;
  max: number;
  step: number;
};

export type DecimalFieldV1 = {
  kind: "decimal";
  id: DefinitionId;
  label: string;
  default: number;
  required: boolean;
  min: number;
  max: number;
  step: number;
};

export type BooleanFieldV1 = {
  kind: "boolean";
  id: DefinitionId;
  label: string;
  default: boolean;
  required: boolean;
};

export type SingleChoiceFieldV1 = {
  kind: "singleChoice";
  id: DefinitionId;
  label: string;
  required: boolean;
  default: DefinitionId | null;
  options: ChoiceOptionV1[];
};

export type MultiChoiceFieldV1 = {
  kind: "multiChoice";
  id: DefinitionId;
  label: string;
  required: boolean;
  default: DefinitionId[];
  options: ChoiceOptionV1[];
};

export type ResourceFieldV1 = {
  kind: "resource";
  id: DefinitionId;
  label: string;
  default: { current: number; max: number };
  min: number;
  max: number;
  step: number;
  resetTo: "min" | "max";
  maxExpressionId?: DefinitionId;
};

export type ComputedFieldV1 = {
  kind: "computed";
  id: DefinitionId;
  label: string;
  valueType: ValueType;
  expressionId: DefinitionId;
};

export type ImageFieldV1 = {
  kind: "image";
  id: DefinitionId;
  label: string;
  required: boolean;
};

export type FieldV1 =
  | TextFieldV1
  | IntegerFieldV1
  | DecimalFieldV1
  | BooleanFieldV1
  | SingleChoiceFieldV1
  | MultiChoiceFieldV1
  | ResourceFieldV1
  | ComputedFieldV1
  | ImageFieldV1;

export type EntityDefinitionV1 = {
  id: EntityTypeId;
  label: string;
  fields: FieldV1[];
};

export type CompiledExpressionSummary = {
  id: DefinitionId;
  context: "computed" | "roll" | "validation" | "outcome";
  resultType: ValueType;
  fallback: ScalarValue;
  ast: ExpressionAstV1;
  /**
   * Preview-only marker. Absent when the entry compiled cleanly under the
   * preview env. `"uncompilable"` = failed preview compile (ast is a
   * fallback literal so preview renders the sampled fallback value);
   * `"invalid"` = the stored entry failed shape validation and was coerced
   * to a fallback literal. The entry is always included — never omitted —
   * so preview cannot silently drop an advanced definition.
   */
  previewError?: "invalid" | "uncompilable" | undefined;
};

export type SystemPackageV1 = {
  presentation?: import("../theme/SystemPresentation.js").SystemPresentation;
  entities: EntityDefinitionV1[];
  expressions: CompiledExpressionSummary[];
  datasets?: readonly RulesDataset[];
  slotsByEntity?: Record<string, SlotEnvironment>;
};

export type SampleScalarValue = number | string | boolean | null;
export type SampleMultiChoiceValue = DefinitionId[];
export type SampleResourceValue = { current: number; max: number };
export type SampleFieldValue =
  | SampleScalarValue
  | SampleMultiChoiceValue
  | SampleResourceValue;
export type SampleRecord = {
  fields: Record<DefinitionId, SampleFieldValue>;
};
export type SampleData = Record<EntityTypeId, SampleRecord>;

const FIXED_RNG: () => number = () => 0.5;

function isScalar(v: unknown): v is SampleScalarValue {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function initialSampleValue(field: FieldV1): SampleFieldValue {
  switch (field.kind) {
    case "text":
      return field.default;
    case "integer":
      return field.default;
    case "decimal":
      return field.default;
    case "boolean":
      return false;
    case "singleChoice": {
      const first = field.options[0];
      return first ? first.id : null;
    }
    case "multiChoice": {
      const first = field.options[0];
      return first ? [first.id] : [];
    }
    case "resource":
      return { current: field.max, max: field.max };
    case "computed":
      return null;
    case "image":
      return null;
  }
}

export function buildSampleBindings(
  fields: Record<DefinitionId, SampleFieldValue>,
): Record<string, BindingValue> {
  const bindings: Record<string, BindingValue> = {};
  for (const [id, value] of Object.entries(fields)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      bindings[id] = value.current;
      bindings[`${id}.current`] = value.current;
      bindings[`${id}.max`] = value.max;
    } else {
      bindings[id] = value;
    }
  }
  return bindings;
}

function normalizeFallback(fallback: ScalarValue): SampleScalarValue {
  return isScalar(fallback) ? fallback : null;
}

function applyComputedFallback(
  field: ComputedFieldV1,
  expressions: CompiledExpressionSummary[],
  fields: Record<DefinitionId, SampleFieldValue>,
): void {
  const expr = expressions.find((e) => e.id === field.expressionId);
  if (expr && expr.context === "computed") {
    fields[field.id] = normalizeFallback(expr.fallback);
  } else {
    fields[field.id] = null;
  }
}

export function generateSample(pkg: SystemPackageV1): SampleData {
  const sample: SampleData = {};
  for (const entity of pkg.entities) {
    const fields: Record<DefinitionId, SampleFieldValue> = {};
    for (const field of entity.fields) {
      fields[field.id] = initialSampleValue(field);
    }
    for (const field of entity.fields) {
      if (field.kind === "computed") {
        applyComputedFallback(field, pkg.expressions, fields);
      }
    }
    const slots = pkg.slotsByEntity?.[entity.id];
    const env = { fields: entityFieldTypes(entity.fields), inputs: {},
      ...(pkg.datasets && { datasets: pkg.datasets }), ...(slots && { slots }),
    };
    const completed = new Set<string>();
    const visited = new Set<string>();
    const evaluateField = (id: string) => {
      if (completed.has(id) || visited.has(id)) return;
      const field = entity.fields.find(candidate => candidate.id === id);
      const expressionId = field?.kind === "computed" ? field.expressionId : field?.kind === "resource" ? field.maxExpressionId : undefined;
      const expr = pkg.expressions.find(candidate => candidate.id === expressionId && candidate.context === "computed");
      if (field === undefined || expr === undefined) return;
      visited.add(id);
      resolveDependencies(expr.ast).forEach(evaluateField);
      const result = evaluateExpression({
        source: renderExpression(expr.ast), env, resultType: expr.resultType,
        fallback: normalizeFallback(expr.fallback), bindings: buildSampleBindings(fields), rng: FIXED_RNG, context: "computed",
      });
      if (result.ok) {
        if (field.kind === "resource" && typeof result.value === "number") {
          const bounded = Math.min(field.max, Math.max(field.min, result.value));
          const max = field.min + Math.floor((bounded - field.min) / field.step + 1e-8) * field.step;
          fields[id] = { max, current: Math.min(field.default.current, max) };
        } else if (field.kind === "computed") fields[id] = result.value;
      }
      visited.delete(id);
      completed.add(id);
    };
    entity.fields.forEach(field => evaluateField(field.id));
    sample[entity.id] = { fields };
  }
  return sample;
}
