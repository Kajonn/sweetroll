import { describe, expect, it } from "vitest";

import { tokenizeExpression } from "./expressions.js";

describe("tokenizeExpression", () => {
  it("tokenizes a simple arithmetic expression", () => {
    const r = tokenizeExpression("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([
      { kind: "number", value: 10, start: 0 },
      { kind: "operator", op: "+", start: 3 },
      { kind: "id", scope: "fields", id: "modifier", start: 5 },
    ]);
  });

  it("rejects an unknown bare word", () => {
    const r = tokenizeExpression("foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects an unknown scope", () => {
    const r = tokenizeExpression("things.modifier");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("recognizes booleans, references, and operators", () => {
    const r = tokenizeExpression("fields.ability >= 3 && true");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => t.kind)).toEqual(["id", "operator", "number", "operator", "boolean"]);
  });

  it("tokenizes parentheses", () => {
    const r = tokenizeExpression("(10 + 2)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => t.kind)).toEqual(["lparen", "number", "operator", "number", "rparen"]);
  });

  it("accepts the d20 check expression from the shipped fixture", () => {
    const r = tokenizeExpression("d20 + fields.modifier + inputs.bonus");
    expect(r.ok).toBe(true);
  });

  it("accepts dice notation per grammar v0.1", () => {
    const r = tokenizeExpression("4d6");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([{ kind: "dice", count: 4, sides: 6, start: 0 }]);
  });

  it("accepts adv/dis sugar per grammar v0.1", () => {
    const r = tokenizeExpression("adv");
    expect(r.ok).toBe(true);
  });

  it("tokenizes inputs-scope references", () => {
    const r = tokenizeExpression("inputs.bonus");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([{ kind: "id", scope: "inputs", id: "bonus", start: 0 }]);
  });

  it("tokenizes decimal numbers", () => {
    const r = tokenizeExpression("1.5");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([{ kind: "number", value: 1.5, start: 0 }]);
  });

  it("rejects trailing decimal points", () => {
    const r = tokenizeExpression("1.");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects unexpected characters", () => {
    const r = tokenizeExpression("10 + $");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });
});
