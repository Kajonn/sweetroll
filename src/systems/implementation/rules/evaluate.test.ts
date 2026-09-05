import { describe, expect, it } from "vitest";
import type { CompiledExpressionV1 } from "../package/schema/index.js";
import { compileExpression, type CompileExpressionOpts } from "./compile.js";
import { evaluate } from "./evaluate.js";

const env = { fields: { modifier: "number" }, inputs: {} } as const;
const rollOpts: CompileExpressionOpts = { env: env as never, resultType: "number", context: "roll", fallback: 0 };

function compile(src: string, opts: CompileExpressionOpts = rollOpts): CompiledExpressionV1 {
  const r = compileExpression(src, opts);
  if (!r.ok) throw new Error("compile fail");
  return { ...r.value, id: "test" };
}
function seqRng(seq: number[]): () => number { let i = 0; return () => seq[i++]!; }

describe("evaluate", () => {
  it("evaluates arithmetic against bindings", () => {
    const r = evaluate(compile("10 + fields.modifier"), { fields: { modifier: 7 }, inputs: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(17);
    expect(r.roll).toBeNull();
    expect(r.diagnostics).toEqual([]);
  });

  it("rolls a d20 deterministically with a seeded rng", () => {
    const r = evaluate(compile("d20"), { fields: {}, inputs: {} }, seqRng([0.05]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll).not.toBeNull();
    if (!r.roll) return;
    expect(r.roll.dice).toEqual([{ sides: 20, value: 1, kept: true }]);
    expect(r.roll.total).toBe(1);
  });

  it("handles division by zero via fallback + diagnostic", () => {
    const r = evaluate(compile("1 / fields.modifier", { ...rollOpts, context: "computed" }), {
      fields: { modifier: 0 },
      inputs: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]!.code).toBe("arithmetic_failure");
  });

  it("returns individual dice for successCount", () => {
    const src = "countSuccesses(dice(3, 6), 4)";
    const r = evaluate(compile(src), { fields: {}, inputs: {} }, seqRng([0.1, 0.9, 0.95]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll!.dice.map((d) => [d.sides, d.value, d.kept])).toEqual([
      [6, 1, true], [6, 6, true], [6, 6, true],
    ]);
    expect(r.roll!.total).toBe(2);
  });

  it("rounds per mode", () => {
    const up = evaluate(compile("round(2.4, up)"), { fields: {}, inputs: {} });
    expect(up.ok && up.result).toBe(3);
  });

  it("falls back when a dynamic dice count exceeds the dice-per-roll ceiling", () => {
    const r = evaluate(compile("dice(101, 6)"), { fields: {}, inputs: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics.some((d) => d.code === "arithmetic_failure")).toBe(true);
    expect(r.roll!.dice).toEqual([]);
  });

  it("falls back when die sides exceed the sides-per-die ceiling", () => {
    const r = evaluate(compile("dice(2, 1001)"), { fields: {}, inputs: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics.some((d) => d.code === "arithmetic_failure")).toBe(true);
  });

  it("resolves equal definition IDs independently by reference scope", () => {
    const scopedEnv = { fields: { bonus: "number" }, inputs: { bonus: "number" } } as const;
    const expression = compile("fields.bonus * 10 + inputs.bonus", {
      env: scopedEnv as never,
      resultType: "number",
      context: "roll",
      fallback: 0,
    });

    const r = evaluate(expression, { fields: { bonus: 2 }, inputs: { bonus: 7 } });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(27);
    expect(r.bindings).toEqual([
      { scope: "fields", definitionId: "bonus", value: 2 },
      { scope: "inputs", definitionId: "bonus", value: 7 },
    ]);
  });

  it("enforces an effective dice limit below the platform ceiling", () => {
    const r = evaluate(
      compile("dice(3, 6)"),
      { fields: {}, inputs: {} },
      seqRng([0.1, 0.2, 0.3]),
      { dicePerRoll: 2, sidesPerDie: 6 },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.roll?.dice).toEqual([]);
    expect(r.diagnostics[0]?.message).toBe("dice count 3 exceeds the 2-die-per-roll limit");
  });

  it("enforces the effective dice limit across the complete expression", () => {
    const r = evaluate(
      compile("dice(2, 6) + dice(2, 6)"),
      { fields: {}, inputs: {} },
      seqRng([0.1, 0.2, 0.3, 0.4]),
      { dicePerRoll: 3, sidesPerDie: 6 },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics[0]?.message).toBe("dice count 4 exceeds the 3-die-per-roll limit");
  });
});
