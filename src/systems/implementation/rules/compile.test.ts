import { describe, expect, it } from "vitest";
import { compileExpression, type CompileExpressionOpts } from "./compile.js";

const env = { fields: { modifier: "number", move_stat: "number" }, inputs: { bonus: "number", forward: "number" } } as const;
const numberOpts: CompileExpressionOpts = { env: env as never, resultType: "number", context: "roll", fallback: 0 };
describe("compileExpression", () => {
  it("compiles defense_expr", () => {
    const r = compileExpression("10 + fields.modifier", { ...numberOpts, context: "computed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dependencies).toEqual(["modifier"]);
    expect(r.value.cost).toBe(3);
    expect(r.value.inferredType).toBe("number");
    expect(r.value.resultType).toBe("number");
    expect(r.value.fallback).toBe(0);
    expect(r.value.ast).toEqual({
      kind: "binary", operator: "+",
      left: { kind: "numberLiteral", value: 10 },
      right: { kind: "reference", scope: "fields", id: "modifier" },
    });
  });

  it("rejects inferred type != declared", () => {
    const r = compileExpression("fields.modifier + 1", { ...numberOpts, resultType: "boolean" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_expression");
  });

  it("rejects fallback type != result type", () => {
    const r = compileExpression("fields.modifier + 1", { ...numberOpts, fallback: "oops" });
    expect(r.ok).toBe(false);
  });

  it("rejects an expression over the node budget", () => {
    const src = repeatBinary(300);
    const r = compileExpression(src, { ...numberOpts, context: "computed" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "limit_exceeded")).toBe(true);
  });
});

function repeatBinary(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push("1");
  return parts.join(" + ");
}
