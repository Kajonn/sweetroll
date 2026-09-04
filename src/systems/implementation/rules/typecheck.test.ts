import { describe, expect, it } from "vitest";
import type { ExpressionAstV1 } from "../package/schema/index.js";
import { parse } from "./parser.js";
import { inferType, resolveDependencies, checkDeterministic, type ExpressionCompileEnv } from "./typecheck.js";

const env: ExpressionCompileEnv = {
  fields: { ability: "number", modifier: "number", move_stat: "number", harm: "number" },
  inputs: { bonus: "number", forward: "number" },
};

function ast(source: string) { const r = parse(source); if (!r.ok) throw new Error("parse fail"); return r.ast; }

describe("typecheck", () => {
  it("infers number for arithmetic", () => {
    expect(inferType(ast("10 + fields.modifier"), env)).toEqual({ ok: true, type: "number" });
  });
  it("infers boolean for comparison", () => {
    expect(inferType(ast("fields.ability >= 3"), env)).toEqual({ ok: true, type: "boolean" });
  });
  it("infers boolean for &&", () => {
    expect(inferType(ast("fields.ability >= 3 && fields.ability <= 18"), env)).toEqual({ ok: true, type: "boolean" });
  });
  it("rejects mixed-type equality", () => {
    const r = inferType(ast("fields.modifier == true"), env);
    expect(r.ok).toBe(false);
  });
  it("returns missing_reference for unknown field", () => {
    const r = inferType(ast("fields.nope + 1"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("missing_reference");
  });
  it("resolves and dedups dependencies in order", () => {
    expect(resolveDependencies(ast("d20 + fields.modifier + inputs.bonus"))).toEqual(["modifier", "bonus"]);
  });
  it("flags dice in a deterministic context", () => {
    expect(checkDeterministic(ast("d20 + 1"), "computed").length).toBeGreaterThan(0);
  });
  it("allows dice in a roll context", () => {
    expect(checkDeterministic(ast("d20 + 1"), "roll")).toEqual([]);
  });
});

describe("typecheck arity enforcement", () => {
  it("rejects min with 0 arguments", () => {
    const r = inferType(ast("min()"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });
  it("rejects min with 1 argument", () => {
    const r = inferType(ast("min(fields.ability)"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });
  it("rejects max with 3 arguments", () => {
    const r = inferType(ast("max(fields.ability, 1, 2)"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });
  it("accepts round with 1 argument (no mode)", () => {
    const r = inferType(ast("round(1.5)"), env);
    expect(r).toEqual({ ok: true, type: "number" });
  });
  it("accepts round with 2 arguments and a mode", () => {
    const r = inferType(ast("round(1.5, down)"), env);
    expect(r).toEqual({ ok: true, type: "number" });
  });
  it("rejects round with 0 arguments", () => {
    const r = inferType(ast("round()"), env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });
  it("rejects round with 3 arguments via direct AST", () => {
    const node: ExpressionAstV1 = {
      kind: "call",
      function: "round",
      arguments: [
        { kind: "numberLiteral", value: 1.5 },
        { kind: "numberLiteral", value: 1 },
        { kind: "numberLiteral", value: 2 },
      ],
    };
    const r = inferType(node, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });
});
