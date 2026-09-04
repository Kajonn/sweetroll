import type { CompiledExpressionV1, ExpressionAstV1, ScalarValue } from "../package/schema/index.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import { renderExpression } from "./render.js";

export type Rng = () => number;

export type RuntimeDiagnostic = { code: "arithmetic_failure"; path: string; message: string };

export type DieResult = { sides: number; value: number; kept: boolean };

export type RollResult = { total: number; dice: DieResult[]; expression: string };

export type EvalResult =
  | { ok: true; roll: RollResult | null; result: ScalarValue; diagnostics: RuntimeDiagnostic[] }
  | { ok: false; diagnostics: RuntimeDiagnostic[] };

type Ctx = {
  bindings: Record<string, ScalarValue>;
  rng: Rng;
  dice: DieResult[];
  diagnostics: RuntimeDiagnostic[];
  expression: string;
};

function fail(ctx: Ctx, message: string): undefined {
  ctx.diagnostics.push({ code: "arithmetic_failure", path: ctx.expression, message });
  return undefined;
}

function num(v: ScalarValue): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function bool(v: ScalarValue): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function isNonNegativeInteger(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}

function rollDice(count: number, sides: number, ctx: Ctx): DieResult[] | undefined {
  if (count > PACKAGE_LIMITS.dicePerRoll) {
    fail(ctx, `dice count ${count} exceeds the ${PACKAGE_LIMITS.dicePerRoll}-die-per-roll limit`);
    return undefined;
  }
  if (sides > PACKAGE_LIMITS.sidesPerDie) {
    fail(ctx, `die sides ${sides} exceed the ${PACKAGE_LIMITS.sidesPerDie}-side-per-die limit`);
    return undefined;
  }
  const dice: DieResult[] = [];
  for (let i = 0; i < count; i++) {
    let value = Math.ceil(ctx.rng() * sides);
    if (value < 1) value = 1;
    dice.push({ sides, value, kept: true });
  }
  return dice;
}

function containsRoll(ast: ExpressionAstV1): boolean {
  switch (ast.kind) {
    case "dice":
    case "keep":
    case "successCount":
      return true;
    case "unary":
      return containsRoll(ast.operand);
    case "binary":
      return containsRoll(ast.left) || containsRoll(ast.right);
    case "call":
      return ast.arguments.some(containsRoll);
    default:
      return false;
  }
}

function equalValues(a: ScalarValue, b: ScalarValue): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}

function evalNode(node: ExpressionAstV1, ctx: Ctx): ScalarValue | undefined {
  switch (node.kind) {
    case "numberLiteral":
      return node.value;
    case "stringLiteral":
      return node.value;
    case "booleanLiteral":
      return node.value;
    case "reference": {
      const val = ctx.bindings[node.id];
      if (val === undefined || val === null) return fail(ctx, `missing reference ${node.scope}.${node.id}`);
      return val;
    }
    case "unary": {
      const v = evalNode(node.operand, ctx);
      if (v === undefined) return undefined;
      if (node.operator === "-") {
        const n = num(v);
        if (n === undefined) return fail(ctx, "unary '-' expects a number");
        return -n;
      }
      const b = bool(v);
      if (b === undefined) return fail(ctx, "unary '!' expects a boolean");
      return !b;
    }
    case "binary": {
      const op = node.operator;
      if (op === "&&" || op === "||") {
        const l = evalNode(node.left, ctx);
        if (l === undefined) return undefined;
        const lb = bool(l);
        if (lb === undefined) return fail(ctx, `'${op}' expects booleans`);
        if (op === "&&" && !lb) return false;
        if (op === "||" && lb) return true;
        const r = evalNode(node.right, ctx);
        if (r === undefined) return undefined;
        const rb = bool(r);
        if (rb === undefined) return fail(ctx, `'${op}' expects booleans`);
        return rb;
      }
      const l = evalNode(node.left, ctx);
      if (l === undefined) return undefined;
      const r = evalNode(node.right, ctx);
      if (r === undefined) return undefined;
      switch (op) {
        case "+": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'+' expects numbers");
          return ln + rn;
        }
        case "-": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'-' expects numbers");
          return ln - rn;
        }
        case "*": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'*' expects numbers");
          return ln * rn;
        }
        case "/": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'/' expects numbers");
          if (rn === 0) return fail(ctx, "division by zero");
          return ln / rn;
        }
        case "<": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'<' expects numbers");
          return ln < rn;
        }
        case "<=": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'<=' expects numbers");
          return ln <= rn;
        }
        case ">": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'>' expects numbers");
          return ln > rn;
        }
        case ">=": {
          const ln = num(l);
          const rn = num(r);
          if (ln === undefined || rn === undefined) return fail(ctx, "'>=' expects numbers");
          return ln >= rn;
        }
        case "==":
          return equalValues(l, r);
        case "!=":
          return !equalValues(l, r);
      }
    }
    case "call": {
      if (node.function === "round") {
        const v = evalNode(node.arguments[0]!, ctx);
        if (v === undefined) return undefined;
        const n = num(v);
        if (n === undefined) return fail(ctx, "round expects a number");
        const mode = node.roundMode ?? "nearest";
        if (mode === "up") return Math.ceil(n);
        if (mode === "down") return Math.floor(n);
        return Math.round(n);
      }
      const a = evalNode(node.arguments[0]!, ctx);
      if (a === undefined) return undefined;
      const b = evalNode(node.arguments[1]!, ctx);
      if (b === undefined) return undefined;
      const an = num(a);
      const bn = num(b);
      if (an === undefined || bn === undefined) return fail(ctx, `${node.function} expects numbers`);
      return node.function === "min" ? Math.min(an, bn) : Math.max(an, bn);
    }
    case "dice": {
      const count = evalNode(node.count, ctx);
      if (count === undefined) return undefined;
      const cn = num(count);
      if (cn === undefined || !isNonNegativeInteger(cn)) return fail(ctx, "dice count must be a non-negative integer");
      const dice = rollDice(cn, node.sides, ctx);
      if (dice === undefined) return undefined;
      ctx.dice.push(...dice);
      return dice.reduce((s, d) => s + d.value, 0);
    }
    case "keep": {
      if (node.dice.kind !== "dice") return fail(ctx, "keep expects a dice expression");
      const count = evalNode(node.dice.count, ctx);
      if (count === undefined) return undefined;
      const cn = num(count);
      if (cn === undefined || !isNonNegativeInteger(cn)) return fail(ctx, "dice count must be a non-negative integer");
      const dice = rollDice(cn, node.dice.sides, ctx);
      if (dice === undefined) return undefined;
      const chosen = Math.min(node.count, dice.length);
      const sorted = [...dice].sort((a, b) => node.mode === "highest" ? b.value - a.value : a.value - b.value);
      const keptSet = new Set(sorted.slice(0, chosen));
      let total = 0;
      for (const d of dice) {
        if (keptSet.has(d)) {
          d.kept = true;
          total += d.value;
        } else {
          d.kept = false;
        }
      }
      ctx.dice.push(...dice);
      return total;
    }
    case "successCount": {
      if (node.dice.kind !== "dice") return fail(ctx, "countSuccesses expects a dice expression");
      const count = evalNode(node.dice.count, ctx);
      if (count === undefined) return undefined;
      const cn = num(count);
      if (cn === undefined || !isNonNegativeInteger(cn)) return fail(ctx, "dice count must be a non-negative integer");
      const dice = rollDice(cn, node.dice.sides, ctx);
      if (dice === undefined) return undefined;
      ctx.dice.push(...dice);
      return dice.reduce((s, d) => (d.value >= node.threshold ? s + 1 : s), 0);
    }
  }
}

export function evaluate(
  compiled: CompiledExpressionV1,
  bindings: Record<string, ScalarValue>,
  rng?: Rng,
): EvalResult {
  const expression = renderExpression(compiled.ast);
  const ctx: Ctx = { bindings, rng: rng ?? Math.random, dice: [], diagnostics: [], expression };
  const value = evalNode(compiled.ast, ctx);
  if (value === undefined) {
    const diagnostics = ctx.diagnostics.length > 0
      ? ctx.diagnostics
      : [{ code: "arithmetic_failure" as const, path: expression, message: "evaluation failed" }];
    const roll = containsRoll(compiled.ast)
      ? { total: num(compiled.fallback) ?? 0, dice: ctx.dice, expression }
      : null;
    return { ok: true, result: compiled.fallback, roll, diagnostics };
  }
  const roll = containsRoll(compiled.ast)
    ? { total: num(value) ?? 0, dice: ctx.dice, expression }
    : null;
  return { ok: true, result: value, roll, diagnostics: ctx.diagnostics };
}