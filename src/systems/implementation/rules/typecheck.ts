import type { ExpressionAstV1, ValueType, DefinitionId } from "../package/schema/index.js";
import type { RulesDiagnostic } from "./diagnostic.js";

export type FieldBindingType = ValueType | "choiceSet";

export type ExpressionCompileEnv = {
  fields: Record<string, FieldBindingType>;
  inputs: Record<string, ValueType>;
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
      const map = ast.scope === "fields" ? env.fields : env.inputs;
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
    case "dice": {
      const c = inferType(ast.count, env);
      if (!c.ok) return c;
      if (c.type !== "number") return diag("invalid_expression", "dice count must be a number expression");
      return { ok: true, type: "number" };
    }
    case "keep": {
      const d = inferType(ast.dice, env);
      if (!d.ok) return d;
      return { ok: true, type: "number" };
    }
    case "successCount": {
      if (ast.dice.kind !== "dice") return diag("invalid_expression", "countSuccesses expects a direct dice expression");
      const d = inferType(ast.dice, env);
      if (!d.ok) return d;
      return { ok: true, type: "number" };
    }
  }
}

export function resolveDependencies(ast: ExpressionAstV1): DefinitionId[] {
  const out: DefinitionId[] = [];
  const seen = new Set<string>();
  const walk = (n: ExpressionAstV1): void => {
    switch (n.kind) {
      case "reference": {
        const key = `${n.scope}:${n.id}`;
        if (!seen.has(key)) { seen.add(key); out.push(n.id); }
        return;
      }
      case "unary": walk(n.operand); return;
      case "binary": walk(n.left); walk(n.right); return;
      case "call": for (const a of n.arguments) walk(a); return;
      case "dice": walk(n.count); return;
      case "keep": walk(n.dice); return;
      case "successCount": walk(n.dice); return;
      default: return;
    }
  };
  walk(ast);
  return out;
}

export function checkDeterministic(ast: ExpressionAstV1, context: "computed" | "roll" | "validation"): RulesDiagnostic[] {
  if (context === "roll") return [];
  const out: RulesDiagnostic[] = [];
  const walk = (n: ExpressionAstV1): void => {
    if (n.kind === "dice" || n.kind === "keep" || n.kind === "successCount") {
      out.push({ code: "invalid_expression", path: "", message: "dice expressions are only valid in roll contexts" });
    }
    switch (n.kind) {
      case "unary": walk(n.operand); return;
      case "binary": walk(n.left); walk(n.right); return;
      case "call": for (const a of n.arguments) walk(a); return;
      case "dice": walk(n.count); return;
      case "keep": walk(n.dice); return;
      case "successCount": walk(n.dice); return;
      default: return;
    }
  };
  walk(ast);
  return out;
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
