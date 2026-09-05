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
  context: "computed" | "roll" | "validation";
  resultType: ValueType;
  fallback: ScalarValue;
  ast: ExpressionAstV1;
};

export type SystemPackageV1 = {
  entities: EntityDefinitionV1[];
  expressions: CompiledExpressionSummary[];
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

function fieldValueType(field: FieldV1): ValueType | undefined {
  switch (field.kind) {
    case "text":
      return "text";
    case "integer":
    case "decimal":
    case "resource":
      return "number";
    case "boolean":
      return "boolean";
    case "singleChoice":
    case "multiChoice":
      return "text";
    case "computed":
      return field.valueType;
    case "image":
      return undefined;
  }
}

function buildSampleBindings(
  fields: Record<DefinitionId, SampleFieldValue>,
): Record<string, ScalarValue> {
  const bindings: Record<string, ScalarValue> = {};
  for (const [id, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      continue;
    }
    if (typeof value === "object") {
      bindings[id] = value.current;
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
    const env: { fields: Record<string, ValueType>; inputs: Record<string, ValueType> } = {
      fields: {},
      inputs: {},
    };
    for (const field of entity.fields) {
      const vt = fieldValueType(field);
      if (vt !== undefined) {
        env.fields[field.id] = vt;
      }
    }
    for (const field of entity.fields) {
      if (field.kind !== "computed") continue;
      const expr = pkg.expressions.find((e) => e.id === field.expressionId);
      if (!expr || expr.context !== "computed") continue;
      const bindings = buildSampleBindings(fields);
      const safeFallback = normalizeFallback(expr.fallback);
      const result = evaluateExpression({
        source: renderExpression(expr.ast),
        env,
        resultType: expr.resultType,
        fallback: safeFallback,
        bindings,
        rng: FIXED_RNG,
      });
      if (result.ok) {
        fields[field.id] = result.value;
      }
    }
    sample[entity.id] = { fields };
  }
  return sample;
}
