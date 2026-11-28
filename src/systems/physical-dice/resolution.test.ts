import { expect, it } from "vitest";
import { compileExpression } from "../implementation/rules/compile.js";
import { evaluate } from "../implementation/rules/evaluate.js";
import { PhysicalDraws, settledValues } from "./resolution.js";

it("resolves prepared d6 and d8 poses through the existing mixed roll calculation", () => {
  const expression = compileExpression("1d6 + 1d8 + 2", {
    env: { fields: {}, inputs: {} },
    context: "roll",
    resultType: "number",
    fallback: 0,
  });
  if (!expression.ok) throw Error("mixed roll did not compile");
  const rule = { ...expression.value, id: "mixed" };
  const bindings = { fields: {}, inputs: {} };
  const plan = new PhysicalDraws();
  evaluate(rule, bindings, undefined, undefined, plan.draw);
  expect(plan.dice.map((d) => d.sides)).toEqual([6, 8]);
  const rotations = [
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 0.333338, y: 0.816496, z: 0, w: 1 - 0.471401 },
  ];
  const values = settledValues(
    plan.dice,
    plan.dice.map(({ id }, i) => {
      const q = rotations[i]!;
      const n = Math.hypot(q.x, q.y, q.z, q.w);
      return {
        id,
        value: [3, 7][i]!,
        orientation: { x: q.x / n, y: q.y / n, z: 0, w: q.w / n },
        position: { x: i, y: 0, z: 1 },
      };
    }),
  );
  expect(values).toEqual([3, 7]);
  const accepted = new PhysicalDraws(plan.dice, values!);
  const actual = evaluate(rule, bindings, undefined, undefined, accepted.draw);
  const control = [2.5 / 6, 6.5 / 8];
  expect(actual).toEqual(evaluate(rule, bindings, () => control.shift()!));
  expect(actual.ok && actual.roll?.total).toBe(12);
});

it.each([
  ["keepHighest(dice(3, 6), 2)", [2, 6, 4], 10],
  ["countSuccesses(dice(3, 6), 4)", [2, 6, 4], 2],
] as const)("preserves the full breakdown for %s", (source, values, total) => {
  const expression = compileExpression(source, {
    env: { fields: {}, inputs: {} },
    context: "roll",
    resultType: "number",
    fallback: 0,
  });
  if (!expression.ok) throw Error(source);
  const rule = { ...expression.value, id: "pool" };
  const bindings = { fields: {}, inputs: {} };
  const plan = new PhysicalDraws();
  evaluate(rule, bindings, undefined, undefined, plan.draw);
  const faces = new PhysicalDraws(plan.dice, [...values]);
  const result = evaluate(rule, bindings, undefined, undefined, faces.draw);
  const rng = values.map((v) => (v - 0.5) / 6);
  expect(faces.complete).toBe(true);
  expect(result).toEqual(evaluate(rule, bindings, () => rng.shift()!));
  expect(result.ok && result.roll?.total).toBe(total);
});

it.each(["explode(d6)", "rerollOnce(d6, 1)", "d100"])(
  "detects unsupported throws before accepting %s",
  (source) => {
    const expression = compileExpression(source, {
      env: { fields: {}, inputs: {} },
      context: "roll",
      resultType: "number",
      fallback: 0,
    });
    if (!expression.ok) throw Error(source);
    const draws = new PhysicalDraws();
    draws.checkExpression(expression.value.ast);
    evaluate(
      { ...expression.value, id: "test" },
      { fields: {}, inputs: {} },
      undefined,
      undefined,
      draws.draw,
    );
    expect(draws.supported).toBe(false);
  },
);

it("accepts a tilted die read by its closest face and rejects any other value", () => {
  const die = { id: "die", groupId: "g", sides: 6 as const };
  const tilt = { x: Math.sin(Math.PI / 12), y: 0, z: 0, w: Math.cos(Math.PI / 12) };
  const pose = (value: number) => [{ id: "die", value, orientation: tilt, position: { x: 0, y: 0, z: 1 } }];
  expect(settledValues([die], pose(3))).toEqual([3]);
  expect(settledValues([die], pose(1))).toBeNull();
});
