import { describe, expect, it } from "vitest";
import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { parse } from "./parser.js";
import { createDeterministicRng } from "../runtime/deterministic-rng.js";
import { renderExpression } from "./render.js";

const env = { fields: { trait: "number" as const }, inputs: { difficulty: "number" as const } };
function roll(source: string, draws: number[], trait = 8, difficulty = 5) {
  const compiled = compileExpression(source, { env, context: "roll", resultType: "number", fallback: -1 });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  let index = 0;
  const result = evaluate({ ...compiled.value, id: "test" }, { fields: { trait }, inputs: { difficulty } }, () => {
    if (index >= draws.length) throw new Error("Unexpected extra die");
    return draws[index++]!;
  });
  expect(index).toBe(draws.length);
  return result;
}

describe("R4 dice pools", () => {
  it("uses dynamic dice sides, thresholds, and the same named dice to count ones", () => {
    const result = roll('countAtLeast(group("check", "Check", dice(3, fields.trait)), inputs.difficulty) - countEqual(rolled("check"), 1)', [0.9, 0.1, 0.8]);
    expect(result).toMatchObject({ ok: true, result: 1, roll: { breakdown: {
      groups: [{ id: "check", sides: 8, operation: "countAtLeast", threshold: 5 }],
      terms: expect.arrayContaining([expect.objectContaining({ operation: "countEqual", groupId: "check", value: 1 })]),
    } } });
  });

  it("can read d100 doubles without drawing twice", () => {
    expect(roll('if(group("check", "Check", d100) % 11 == 0, rolled("check") + 100, rolled("check"))', [0.44]))
      .toMatchObject({ ok: true, result: 144 });
  });

  it("uses a single reroll and keeps complete explosion chains", () => {
    const result = roll("keepHighest(explode(rerollOnce(dice(2, fields.trait), 1)), inputs.difficulty)", [0.05, 0.96, 0.3, 0.8], 8, 1);
    expect(result).toMatchObject({ ok: true, result: 11, roll: { dice: [
      { value: 1, kept: false }, { value: 8, kept: true, rerolledFrom: "@root:0" },
      { value: 3, kept: true, explodedFrom: "@root:0:r" }, { value: 7, kept: false },
    ] } });
  });

  it("caps explosions at ten per die and counts every draw against the roll limit", () => {
    expect(roll("explode(d6)", Array(11).fill(1))).toMatchObject({ ok: true, result: 66 });
    expect(roll("explode(10d6)", Array(100).fill(1))).toMatchObject({ ok: false, diagnostics: [{ code: "budget_exceeded" }] });
  });

  it("rejects forward or conditionally unavailable group references at publish", () => {
    for (const source of ['rolled("g") + group("g", "G", d6)', 'if(fields.trait > 4, group("g", "G", d6), 0) + rolled("g")']) {
      expect(compileExpression(source, { env, context: "roll", resultType: "number", fallback: 0 })).toMatchObject({ ok: false });
    }
  });

  it("validates integer parameters before drawing and records a fallback graph", () => {
    expect(roll("countAtMost(dice(2, fields.trait), inputs.difficulty)", [], 6, 3.5))
      .toMatchObject({ ok: true, result: -1, roll: { dice: [], breakdown: { terms: [{ id: "root.0", value: 2 }, { id: "root.1", value: 6 }, { id: "root.2", value: 3.5 }, { id: "root", operation: "fallback", value: -1 }] } } });
  });

  it("round trips new syntax and keeps shorthand as a pool", () => {
    for (const source of ["4d6kh3", "adv(d20)", "countSuccesses(d6, 6)", 'keepLowest(explode(group("g", "G", dice(3, fields.trait)), 6), inputs.difficulty)']) {
      const parsed = parse(source);
      expect(parsed).toMatchObject({ ok: true, ast: { kind: "pool" } });
      if (parsed.ok) expect(parse(renderExpression(parsed.ast))).toEqual(parsed);
    }
  });

  it("distributes faces evenly for a uniform draw grid", () => {
    const draws = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100);
    const result = roll("dice(100, fields.trait)", draws, 10);
    expect(result).toMatchObject({ ok: true, result: 550, roll: { dice: draws.map((_, i) => ({ value: 1 + Math.floor(i / 10) })) } });
  });

  it("keeps each d10 face close to uniform over ten thousand seeded draws", () => {
    const compiled = compileExpression("dice(100, fields.trait)", { env, context: "roll", resultType: "number", fallback: 0 });
    if (!compiled.ok) throw new Error("Expected a valid pool");
    const rng = createDeterministicRng("r4-test-deterministic-roll-secret", "face-distribution");
    const frequencies = Array<number>(10).fill(0);
    for (let i = 0; i < 100; i++) {
      const result = evaluate({ ...compiled.value, id: "test" }, { fields: { trait: 10 }, inputs: {} }, rng);
      if (!result.ok || !result.roll) throw new Error("Expected a roll");
      for (const die of result.roll.dice) frequencies[die.value - 1]!++;
    }
    for (const frequency of frequencies) {
      expect(frequency).toBeGreaterThan(870);
      expect(frequency).toBeLessThan(1130);
    }
  });
});
