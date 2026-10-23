import { describe, expect, it } from "vitest";

import { evaluateRoll } from "../api/evaluateExpression.js";
import { evaluateExpression, additiveRollModifier } from "./evaluateExpression.js";

const numberEnv = { fields: {}, inputs: {} };
const intBindings: Record<string, number> = {};

function fixedRng(value: number): () => number {
  let used = false;
  return () => {
    if (used) return 0;
    used = true;
    return value;
  };
}

describe("evaluateExpression", () => {
  it("evaluates a simple numeric expression", () => {
    const result = evaluateExpression({
      source: "2 + 3",
      env: numberEnv,
      resultType: "number",
      fallback: 0,
      bindings: intBindings,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(5);
    expect(result.roll).toBeNull();
  });

  it("returns a roll result with deterministic dice when given a fixed rng", () => {
    const result = evaluateExpression({
      source: "d20",
      env: numberEnv,
      resultType: "number",
      fallback: 0,
      bindings: intBindings,
      rng: fixedRng(0.75),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll).not.toBeNull();
    expect(result.roll?.total).toBe(15);
    expect(result.roll?.dice).toEqual([{ sides: 20, value: 15, kept: true }]);
  });

  it("computes the modifier as total minus dice sum for arithmetic rolls", () => {
    const result = evaluateExpression({
      source: "d20 + 5",
      env: numberEnv,
      resultType: "number",
      fallback: 0,
      bindings: intBindings,
      rng: fixedRng(0.5),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.roll === null) return;
    const diceSum = result.roll.dice.reduce((s, d) => s + d.value, 0);
    const modifier = result.roll.total - diceSum;
    expect(modifier).toBe(5);
  });

  it("returns parse diagnostics for invalid syntax", () => {
    const result = evaluateExpression({
      source: "@@",
      env: numberEnv,
      resultType: "number",
      fallback: 0,
      bindings: intBindings,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("invalid_syntax");
  });

  it("returns typecheck diagnostics when a fields reference is unknown", () => {
    const result = evaluateExpression({
      source: "fields.modifier + 2",
      env: numberEnv,
      resultType: "number",
      fallback: 0,
      bindings: intBindings,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("missing_reference");
  });

  it("evaluates against provided bindings", () => {
    const result = evaluateExpression({
      source: "fields.modifier + inputs.bonus",
      env: { fields: { modifier: "number" }, inputs: { bonus: "number" } },
      resultType: "number",
      fallback: 0,
      bindings: { modifier: 3, bonus: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(5);
  });
});


describe("truthful roll breakdown", () => {
  it.each([
    ["countSuccesses(3d6, 6)", null],
    ["countSuccesses(2d6, 6) + countSuccesses(2d6, 5)", null],
    ["d6 + countSuccesses(2d6, 6)", null],
    ["2 * d6", null], ["-d6", null], ["10 - d6", null],
    ["d20 + 5", 5], ["4d6kh3 + 2", 2], ["d6 + d6 - 3", -3],
  ])("only explains additive dice: %s", (source, expected) => {
    const result = evaluateExpression({ source, env: { fields: {}, inputs: {} }, resultType: "number", fallback: 0, bindings: {}, rng: () => 1 });
    expect(additiveRollModifier(result)).toBe(expected);
  });

  it.each(["countSuccesses(dice(-1, 6), 6)", "d6 + 1/0"])("does not preview a fallback/partial roll as success: %s", (source) => {
    const { result } = evaluateRoll({ source, env: { fields: {}, inputs: {} }, resultType: "number", fallback: 0, bindings: {} });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "arithmetic_failure" }] });
  });
});


it("preserves scalar preview fallbacks while rejecting the same arithmetic failure as an action", () => {
  const input = { source: "1 / 0", env: { fields: {}, inputs: {} }, resultType: "number" as const, fallback: 7, bindings: {} };
  expect(evaluateExpression(input)).toMatchObject({ ok: true, value: 7, roll: null, diagnostics: [{ code: "arithmetic_failure" }] });
  expect(evaluateRoll(input).result).toMatchObject({ ok: false, diagnostics: [{ code: "arithmetic_failure" }] });
});
