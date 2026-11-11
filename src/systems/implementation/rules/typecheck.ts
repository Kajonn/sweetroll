import type { CustomDie } from "../package/schema/dice.js";
import { children, containsDice, drawsDice } from "./groups.js";
import type { ExpressionAstV1, ValueType, DefinitionId } from "../package/schema/index.js";
import { aggregateCall, isAggregate, literalId, type RulesDataset, type SlotEnvironment } from "./data.js";
import type { RulesDiagnostic } from "./diagnostic.js";

export type FieldBindingType = ValueType | "choiceSet";

export type ExpressionCompileEnv = {
  fields: Record<string, FieldBindingType>;
  inputs: Record<string, ValueType>;
  item?: Record<string, FieldBindingType>;
  target?: Record<string, FieldBindingType>;
  opposed?: Record<string, ValueType>;
  /** Outcome expressions only: values of the roll being described (`roll.total`). */
  roll?: Record<string, ValueType>;
  dice?: readonly CustomDie[] | undefined;
  datasets?: readonly RulesDataset[];
  slots?: SlotEnvironment;
};

export type InferResult =
  | { ok: true; type: FieldBindingType }
  | { ok: false; diagnostics: RulesDiagnostic[] };

function diag(code: string, message: string): InferResult {
  return { ok: false, diagnostics: [{ code, path: "", message }] };
}

export function referenceKey(reference: Extract<ExpressionAstV1, { kind: "reference" }>): string {
  return reference.part === undefined ? reference.id : `${reference.id}.${reference.part}`;
}

export function inferType(ast: ExpressionAstV1, env: ExpressionCompileEnv): InferResult {
  switch (ast.kind) {
    case "numberLiteral": return { ok: true, type: "number" };
    case "stringLiteral": return { ok: true, type: "text" };
    case "booleanLiteral": return { ok: true, type: "boolean" };
    case "reference": {
      const map = env[ast.scope] ?? {};
      const key = referenceKey(ast);
      if (!Object.hasOwn(map, key)) return diag("missing_reference", `unknown ${ast.scope} reference '${key}'`);
      return { ok: true, type: map[key]! };
    }
    case "unary": {
      const op = inferType(ast.operand, env);
      if (!op.ok) return op;
      if (ast.operator === "!") {
        return op.type === "boolean" ? { ok: true, type: "boolean" } : diag("invalid_expression", "operand of '!' must be boolean");
      }
      return op.type === "number" ? { ok: true, type: "number" } : diag("invalid_expression", "operand of unary '-' must be number");
    }
    case "binary": {
      const l = inferType(ast.left, env);
      if (!l.ok) return l;
      const r = inferType(ast.right, env);
      if (!r.ok) return r;
      switch (ast.operator) {
        case "+": case "-": case "*": case "/": case "%":
          return l.type === "number" && r.type === "number" ? { ok: true, type: "number" } : diag("invalid_expression", "arithmetic operands must be number");
        case "<": case "<=": case ">": case ">=":
          return l.type === "number" && r.type === "number" ? { ok: true, type: "boolean" } : diag("invalid_expression", "comparison operands must be number");
        case "==": case "!=":
          return l.type === r.type && l.type !== "choiceSet" ? { ok: true, type: "boolean" } : diag("invalid_expression", "equality operands must have the same type");
        case "&&": case "||":
          return l.type === "boolean" && r.type === "boolean" ? { ok: true, type: "boolean" } : diag("invalid_expression", "'&&'/'||' operands must be boolean");
      }
      return diag("invalid_expression", "unknown operator");
    }
    case "call": {
      const nargs = ast.arguments.length;
      if (ast.roundMode !== undefined && ast.function !== "round") {
        return diag("invalid_expression", "only round supports a rounding mode");
      }
      if (ast.function === "lookup" || ast.function === "lookupBand") {
        const [datasetArg, key, columnArg] = ast.arguments;
        const datasetId = literalId(datasetArg);
        const column = literalId(columnArg);
        if (nargs !== 3 || !datasetId || !column || !key) {
          return diag("invalid_expression", `${ast.function} expects a quoted dataset ID, a key and a quoted column ID`);
        }
        const dataset = env.datasets?.find(candidate => candidate.id === datasetId);
        if (!dataset?.keyColumn || !dataset.columns || !Object.hasOwn(dataset.columns, column)) {
          return diag("missing_reference", `Unknown typed dataset or column '${datasetId}.${column}'`);
        }
        const keyType = dataset.columns[dataset.keyColumn];
        const inferredKey = inferType(key, env);
        if (!inferredKey.ok) return inferredKey;
        if (inferredKey.type !== keyType || (ast.function === "lookupBand" && keyType !== "number")) {
          return diag("invalid_expression", `${ast.function} key must match the dataset key type; lookupBand requires numbers`);
        }
        return { ok: true, type: dataset.columns[column]! };
      }
      if (isAggregate(ast.function)) {
        const aggregate = aggregateCall(ast);
        if (!aggregate) return diag("invalid_expression", `${ast.function} expects quoted slot and field IDs`);
        const slot = env.slots && Object.hasOwn(env.slots, aggregate.slot) ? env.slots[aggregate.slot] : undefined;
        if (!slot) return diag("missing_reference", `Unknown slot '${aggregate.slot}' for this entity`);
        if (aggregate.field && (!Object.hasOwn(slot.fields, aggregate.field) || slot.fields[aggregate.field] !== "number")) {
          return diag("invalid_expression", `Aggregate field '${aggregate.field}' must be numeric across templates accepted by '${aggregate.slot}'`);
        }
        if (aggregate.flag && (!Object.hasOwn(slot.fields, aggregate.flag) || slot.fields[aggregate.flag] !== "boolean")) {
          return diag("invalid_expression", `Aggregate filter '${aggregate.flag}' must be boolean across templates accepted by '${aggregate.slot}'`);
        }
        return { ok: true, type: "number" };
      }
      if (ast.function === "if" || ast.function === "has") {
        const conditional = ast.function === "if";
        if (nargs !== (conditional ? 3 : 2)) {
          return diag("invalid_expression", conditional ? "if expects 3 arguments" : "has expects 2 arguments");
        }
        const types: FieldBindingType[] = [];
        for (const argument of ast.arguments) {
          const result = inferType(argument, env);
          if (!result.ok) return result;
          types.push(result.type);
        }
        const [first, second, third] = types;
        if (conditional) {
          return first === "boolean" && second === third && second !== "choiceSet"
            ? { ok: true, type: second! }
            : diag("invalid_expression", "if expects a boolean condition and two branches of the same scalar type");
        }
        return first === "choiceSet" && ast.arguments[1]?.kind === "stringLiteral"
          ? { ok: true, type: "boolean" }
          : diag("invalid_expression", "has expects a multi-choice field and a quoted option ID");
      }
      if (ast.function === "min" || ast.function === "max") {
        if (nargs < 2 || nargs > 8) return diag("invalid_expression", `${ast.function} expects 2 to 8 arguments`);
      }
      if (ast.function === "round") {
        if (nargs === 0) return diag("invalid_expression", "round expects 1 or 2 arguments");
        if (nargs > 2) return diag("invalid_expression", "round expects 1 or 2 arguments");
      }
      if (["floor", "ceil", "abs"].includes(ast.function) && nargs !== 1) {
        return diag("invalid_expression", `${ast.function} expects 1 argument`);
      }
      for (const a of ast.arguments) {
        const ar = inferType(a, env);
        if (!ar.ok) return ar;
        if (ar.type !== "number") return diag("invalid_expression", "function arguments must be number");
      }
      return { ok: true, type: "number" };
    }
    case "pool": {
      if (ast.source.kind === "custom") {
        const { dieId } = ast.source;
        if (!env.dice?.some((die) => die.id === dieId)) {
          return diag("missing_reference", `Unknown custom die '${dieId}'.`);
        }
      }
      if (ast.reducer?.kind === "countSymbol" && !/^[a-z][a-z0-9_]{0,63}$/.test(ast.reducer.symbol)) {
        return diag("invalid_expression", "Invalid dice symbol ID.");
      }
      for (const parameter of children(ast)) {
        const result = inferType(parameter, env);
        if (!result.ok) return result;
        if (result.type !== "number") return diag("invalid_expression", "dice pool parameters must be numbers");
      }
      return { ok: true, type: "number" };
    }
  }
}

export function resolveDependencies(ast: ExpressionAstV1): DefinitionId[] {
  const out: DefinitionId[] = [];
  const seen = new Set<string>();
  const walk = (node: ExpressionAstV1): void => {
    if (node.kind === "reference") {
      const key = `${node.scope}:${node.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(node.id);
      }
    }
    children(node).forEach(walk);
  };
  walk(ast);
  return out;
}

export function checkDeterministic(ast: ExpressionAstV1, context: "computed" | "roll" | "validation" | "outcome"): RulesDiagnostic[] {
  if (context === "roll" || !containsDice(ast)) return [];
  // An outcome describes a finished roll: it may read rolled("group") but never draws dice.
  if (context === "outcome") {
    return drawsDice(ast)
      ? [{ code: "invalid_expression", path: "", message: "an outcome cannot roll new dice; read the roll with roll.total or rolled(\"group\")" }]
      : [];
  }
  return [{ code: "invalid_expression", path: "", message: "dice expressions are only valid in roll contexts" }];
}

export function entityFieldTypes(fields: readonly { id: string; kind?: unknown; valueType?: unknown }[]): Record<string, FieldBindingType> {
  const types: Record<string, FieldBindingType> = {};
  for (const field of fields) {
    const valueType = fieldToValueType(field);
    if (valueType !== undefined) types[field.id] = valueType;
    if (field.kind === "resource") {
      types[`${field.id}.current`] = "number";
      types[`${field.id}.max`] = "number";
    }
  }
  return types;
}

function fieldToValueType(field: { kind?: unknown; valueType?: unknown }): FieldBindingType | undefined {
  switch (field.kind) {
    case "text": return "text";
    case "integer": return "number";
    case "decimal": return "number";
    case "boolean": return "boolean";
    case "singleChoice": return "text";
    case "multiChoice": return "choiceSet";
    case "resource": return "number";
    case "computed": return field.valueType === "number" || field.valueType === "text" || field.valueType === "boolean" ? field.valueType : undefined;
    case "image": return undefined;
  }
}
