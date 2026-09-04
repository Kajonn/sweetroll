import { describe, expect, it } from "vitest";
import type { ExpressionAstV1 } from "../package/schema/index.js";
import { d20Package, pbta2d6Package, d6SuccessPoolPackage } from "../package/fixtures/index.js";
import { parse } from "./parser.js";
import { renderExpression } from "./render.js";
import type { CompiledExpressionV1 } from "../package/schema/index.js";
import { evaluate, type Rng } from "./evaluate.js";

type Lcg = { next(): number; seed(n: number): void };

function createLcg(s: number): Lcg {
  let state = s;
  return {
    next() {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    },
    seed(n: number) { state = n; },
  };
}

type AstGen = {
  next(): ExpressionAstV1;
  int(): number;
  bool(): boolean;
};

function createAstGen(rng: Lcg): AstGen {
  function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(rng.next() * arr.length)]!;
  }

  function leaf(): ExpressionAstV1 {
    const kind = pick(["numberLiteral", "reference"] as const);
    if (kind === "reference") {
      return { kind: "reference", scope: pick(["fields", "inputs"] as const), id: pick(["a", "b", "mod"] as const) };
    }
    return { kind: "numberLiteral", value: Math.floor(rng.next() * 20) - 5 };
  }

  function ast(depth: number): ExpressionAstV1 {
    if (depth <= 0) return leaf();
    const kind = pick(["literal", "binary", "call"] as const);
    switch (kind) {
      case "literal": return leaf();
      case "binary": {
        const op = pick(["+", "-", "*", "<", "<=", ">", ">=", "==", "!="] as const);
        return { kind: "binary", operator: op, left: ast(depth - 1), right: ast(depth - 1) };
      }
      case "call": {
        const fn = pick(["min", "max", "round"] as const);
        const args: ExpressionAstV1[] = [ast(depth - 1)];
        if (fn !== "round") args.push(ast(depth - 1));
        const node: ExpressionAstV1 = { kind: "call", function: fn, arguments: args };
        if (fn === "round" && rng.next() > 0.5) {
          node.roundMode = pick(["nearest", "up", "down"] as const);
        }
        return node;
      }
    }
  }

  return {
    next: () => ast(Math.floor(rng.next() * 3)),
    int: () => Math.floor(rng.next() * 20) - 5,
    bool: () => rng.next() > 0.5,
  };
}

function compileExpr(ast: ExpressionAstV1, resultType: "number" | "boolean"): CompiledExpressionV1 {
  return {
    id: "prop_test",
    resultType,
    inferredType: resultType,
    fallback: resultType === "number" ? 0 : false,
    dependencies: [],
    cost: 1,
    ast,
  };
}

function roundTrips(ast: ExpressionAstV1): boolean {
  const rendered = renderExpression(ast);
  const result = parse(rendered);
  if (!result.ok) return false;
  return JSON.stringify(result.ast) === JSON.stringify(ast);
}

const N = 100;

describe("property: determinism", () => {
  it(`evaluate returns the same result for the same rng seed (${N} iterations)`, () => {
    const rng = createLcg(42);
    const gen = createAstGen(rng);

    for (let i = 0; i < N; i++) {
      const ast = gen.next();
      const expr = compileExpr(ast, "number");
      const bindings = { a: 3, b: 7, mod: -2 };
      const rng1 = createLcg(1000 + i);
      const rng2 = createLcg(1000 + i);

      const r1 = evaluate(expr, bindings, () => rng1.next());
      const r2 = evaluate(expr, bindings, () => rng2.next());

      expect(r1.ok).toBe(r2.ok);
      if (r1.ok && r2.ok) {
        expect(r1.result).toBe(r2.result);
        expect(r1.roll?.total).toBe(r2.roll?.total);
        expect(r1.roll?.dice.length).toBe(r2.roll?.dice.length);
      }
    }
  });
});

describe("property: round-trip (generated arithmetic)", () => {
  it(`parse(render(ast)) == ast for ${N} generated arithmetic/boolean ASTs`, () => {
    const rng = createLcg(99);
    const gen = createAstGen(rng);

    for (let i = 0; i < N; i++) {
      const ast = gen.next();
      expect(roundTrips(ast)).toBe(true);
    }
  });
});

describe("property: round-trip (d20 fixtures)", () => {
  for (const expr of d20Package.expressions) {
    it(`${expr.id}: parse(render(ast)) deep-equals ast`, () => {
      expect(roundTrips(expr.ast)).toBe(true);
    });
  }
});

describe("property: round-trip (pbta2d6 fixtures)", () => {
  for (const expr of pbta2d6Package.expressions) {
    it(`${expr.id}: parse(render(ast)) deep-equals ast`, () => {
      expect(roundTrips(expr.ast)).toBe(true);
    });
  }
});

describe("property: round-trip (d6SuccessPool fixtures)", () => {
  for (const expr of d6SuccessPoolPackage.expressions) {
    it(`${expr.id}: parse(render(ast)) deep-equals ast`, () => {
      expect(roundTrips(expr.ast)).toBe(true);
    });
  }
});

describe("property: determinism (d20 check_expr)", () => {
  it("same rng seed produces identical dice and total", () => {
    const checkExpr = d20Package.expressions.find((e) => e.id === "check_expr")!;
    const bindings = { modifier: 3, bonus: 1 };

    const r1 = evaluate(checkExpr, bindings, seqRng([0.5, 0.1, 0.9]));
    const r2 = evaluate(checkExpr, bindings, seqRng([0.5, 0.1, 0.9]));

    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.result).toBe(r2.result);
      expect(r1.roll!.total).toBe(r2.roll!.total);
      expect(r1.roll!.dice).toEqual(r2.roll!.dice);
    }
  });

  it("different rng seeds produce different results (high probability)", () => {
    const checkExpr = d20Package.expressions.find((e) => e.id === "check_expr")!;
    const bindings = { modifier: 3, bonus: 1 };

    const r1 = evaluate(checkExpr, bindings, seqRng([0.01, 0.01, 0.01]));
    const r2 = evaluate(checkExpr, bindings, seqRng([0.99, 0.99, 0.99]));

    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.roll!.total).not.toBe(r2.roll!.total);
    }
  });
});

function seqRng(seq: number[]): Rng {
  let i = 0;
  return () => seq[i++]!;
}
