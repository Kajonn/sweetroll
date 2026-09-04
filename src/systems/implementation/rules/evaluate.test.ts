import { describe, expect, it } from "vitest";
import { compileExpression, type CompileExpressionOpts } from "./compile.js";
import { evaluate } from "./evaluate.js";

const env = { fields: { modifier: "number" }, inputs: {} } as const;
const rollOpts: CompileExpressionOpts = { env: env as never, resultType: "number", context: "roll", fallback: 0 };

function compile(src: string, opts: CompileExpressionOpts = rollOpts) {
  const r = compileExpression(src, opts);
  if (!r.ok) throw new Error("compile fail");
  return r.value as never;
}
function seqRng(seq: number[]): () => number { let i = 0; return () => seq[i++]!; }

describe("evaluate", () => {
  it("evaluates arithmetic against bindings", () => {
    const r = evaluate(compile("10 + fields.modifier"), { modifier: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(17);
    expect(r.roll).toBeNull();
    expect(r.diagnostics).toEqual([]);
  });

  it("rolls a d20 deterministically with a seeded rng", () => {
    const r = evaluate(compile("d20"), {}, seqRng([0.05]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll).not.toBeNull();
    if (!r.roll) return;
    expect(r.roll.dice).toEqual([{ sides: 20, value: 1, kept: true }]);
    expect(r.roll.total).toBe(1);
  });

  it("handles division by zero via fallback + diagnostic", () => {
    const r = evaluate(compile("1 / fields.modifier", { ...rollOpts, context: "computed" }), { modifier: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]!.code).toBe("arithmetic_failure");
  });

  it("returns individual dice for successCount", () => {
    const src = "countSuccesses(dice(3, 6), 4)";
    const r = evaluate(compile(src), {}, seqRng([0.1, 0.9, 0.95]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll!.dice.map((d) => [d.sides, d.value, d.kept])).toEqual([
      [6, 1, true], [6, 6, true], [6, 6, true],
    ]);
    expect(r.roll!.total).toBe(2);
  });

  it("rounds per mode", () => {
    const up = evaluate(compile("round(2.4, up)"), {});
    expect(up.ok && up.result).toBe(3);
  });
});