import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenizer.js";

describe("tokenizer", () => {
  it("tokenizes a simple arithmetic expression", () => {
    const r = tokenize("10 + fields.modifier");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([
      { kind: "number", value: 10, start: 0 },
      { kind: "operator", op: "+", start: 3 },
      { kind: "id", scope: "fields", id: "modifier", start: 5 },
    ]);
  });

  it("tokenizes static dice notation with keep", () => {
    const r = tokenize("4d6kh3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([
      { kind: "dice", count: 4, sides: 6, keep: { mode: "highest", count: 3 }, start: 0 },
    ]);
  });

  it("tokenizes d20 with default count 1", () => {
    const r = tokenize("d20");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual([{ kind: "dice", count: 1, sides: 20, keep: undefined, start: 0 }]);
  });

  it("rejects an unknown bare word", () => {
    const r = tokenize("foo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("rejects an unknown scope", () => {
    const r = tokenize("things.modifier");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("invalid_syntax");
  });

  it("recognizes booleans, functions, and operators", () => {
    const r = tokenize("fields.ability >= 3 && true");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => t.kind)).toEqual(["id", "operator", "number", "operator", "boolean"]);
  });
});
