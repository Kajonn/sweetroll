import type { ExpressionAstV1, ValueType, DefinitionId } from "../package/schema/index.js";

export type ExpressionCompileEnv = {
  fields: Record<string, ValueType>;
  inputs: Record<string, ValueType>;
};

type RulesDiagnostic = { code: string; path: string; message: string };

export type InferResult =
  | { ok: true; type: ValueType }
  | { ok: false; diagnostics: RulesDiagnostic[] };

function diag(code: string, message: string): InferResult {
  return { ok: false, diagnostics: [{ code, path: "", message }] };
}

export function inferType(ast: ExpressionAstV1, env: ExpressionCompileEnv): InferResult {
  switch (ast.kind) {
    case "numberLiteral": return { ok: true, type: "number" };
    case "stringLiteral": return { ok: true, type: "text" };
    case "booleanLiteral": return { ok: true, type: "boolean" };
    case "reference": {
      const map = ast.scope === "fields" ? env.fields : env.inputs;
      if (!(ast.id in map)) return diag("missing_reference", `unknown ${ast.scope} reference '${ast.id}'`);
      return { ok: true, type: map[ast.id]! };
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
        case "+": case "-": case "*": case "/":
          return l.type === "number" && r.type === "number" ? { ok: true, type: "number" } : diag("invalid_expression", "arithmetic operands must be number");
        case "<": case "<=": case ">": case ">=":
          return l.type === "number" && r.type === "number" ? { ok: true, type: "boolean" } : diag("invalid_expression", "comparison operands must be number");
        case "==": case "!=":
          return l.type === r.type ? { ok: true, type: "boolean" } : diag("invalid_expression", "equality operands must have the same type");
        case "&&": case "||":
          return l.type === "boolean" && r.type === "boolean" ? { ok: true, type: "boolean" } : diag("invalid_expression", "'&&'/'||' operands must be boolean");
      }
      return diag("invalid_expression", "unknown operator");
    }
    case "call": {
      const nargs = ast.arguments.length;
      if (ast.function === "min" || ast.function === "max") {
        if (nargs !== 2) return diag("invalid_expression", `${ast.function} expects exactly 2 arguments`);
      }
      if (ast.function === "round") {
        if (nargs === 0) return diag("invalid_expression", "round expects 1 or 2 arguments");
        if (nargs > 2) return diag("invalid_expression", "round expects 1 or 2 arguments");
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
