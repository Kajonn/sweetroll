import { describe, expect, it } from "vitest";
import { parse, countNodes } from "./parser.js";

describe("parser", () => {
  it("parses arithmetic with correct AST", () => {
    const r = parse("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "binary", operator: "+",
      left: { kind: "numberLiteral", value: 10 },
      right: { kind: "reference", scope: "fields", id: "modifier" },
    });
  });

  it("parses static dice into a dice node with count 1", () => {
    const r = parse("d20");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({ kind: "dice", count: { kind: "numberLiteral", value: 1 }, sides: 20 });
  });

  it("parses 2d6 + fields.move_stat + inputs.forward", () => {
    const r = parse("2d6 + fields.move_stat + inputs.forward");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "binary", operator: "+",
      left: {
        kind: "binary", operator: "+",
        left: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
        right: { kind: "reference", scope: "fields", id: "move_stat" },
      },
      right: { kind: "reference", scope: "inputs", id: "forward" },
    });
  });

  it("parses keep notation 4d6kh3", () => {
    const r = parse("4d6kh3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "keep", mode: "highest", count: 3,
      dice: { kind: "dice", count: { kind: "numberLiteral", value: 4 }, sides: 6 },
    });
  });

  it("parses successCount", () => {
    const r = parse("countSuccesses(dice(2, 6), 4)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: "successCount",
      dice: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
      threshold: 4,
    });
  });

  it("parses parentheses and unary negation of literal into a negative literal", () => {
    const r = parse("fields.move_stat >= -1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ast = r.ast;
    expect(ast.kind).toBe("binary");
    if (ast.kind !== "binary") return;
    expect(ast.right).toEqual({ kind: "numberLiteral", value: -1 });
  });

  it("rejects a dangling operator with a diagnostic", () => {
    const r = parse("1 +");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects unbalanced parens", () => {
    const r = parse("(1 + 2");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("counts nodes", () => {
    const r = parse("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(countNodes(r.ast)).toBe(3);
  });
});
