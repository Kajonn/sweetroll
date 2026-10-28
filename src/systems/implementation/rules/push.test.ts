import { describe, expect, it, vi } from "vitest";
import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { evaluatePush, type PushEvaluationInput } from "./push.js";
const expression = compileExpression(
  'countSuccesses(group("attribute","Attribute",dice(fields.attribute,6)),6) + countSuccesses(group("skill","Skill",dice(fields.skill,8)),7) + group("gear","Gear",dice(fields.gear,6)) + inputs.modifier',
  {
    context: "roll",
    resultType: "number",
    fallback: 0,
    languageVersion: "0.2",
    env: {
      fields: { attribute: "number", skill: "number", gear: "number" },
      inputs: { modifier: "number" },
    },
  },
);
function fixture(): PushEvaluationInput {
  if (!expression.ok) throw Error("fixture compile");
  const bindings = {
    fields: { attribute: 3, skill: 3, gear: 3 },
    inputs: { modifier: -1 },
  };
  const values = [1, 2, 6, 1, 4, 8, 1, 3, 6];
  const sides = [6, 6, 6, 8, 8, 8, 6, 6, 6];
  let i = 0;
  const parent = evaluate({ id: "roll", ...expression.value }, bindings, () => {
    const n = i++;
    return (values[n]! - 0.5) / sides[n]!;
  });
  if (!parent.ok || !parent.roll) throw Error("fixture evaluation");
  const draws = [(6 - 0.5) / 6, (7 - 0.5) / 8, (2 - 0.5) / 8, (5 - 0.5) / 6];
  let j = 0;
  return {
    expression: { id: "roll", ...expression.value },
    policy: {
      version: "1.0",
      maxAttempts: 2,
      successThreshold: 10,
      allowOnSuccess: true,
      groups: [
        { groupId: "attribute", lockedFaces: [1, 6], reportedFaces: [] },
        { groupId: "skill", lockedFaces: [8], reportedFaces: [] },
        { groupId: "gear", lockedFaces: [1, 6], reportedFaces: [1] },
      ],
    },
    parent: parent.roll,
    bindings,
    attempt: 0,
    rng: vi.fn(() => draws[j++]!),
    limits: { dicePerRoll: 100, sidesPerDie: 1000 },
  };
}
describe("immutable original-pool pushes", () => {
  it("rerolls four eligible dice, preserves IDs/locks and recomputes the mixed graph 11 -> 15", () => {
    const f = fixture(),
      before = structuredClone(f.parent);
    expect(f.parent.total).toBe(11);
    const r = evaluatePush(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roll.total).toBe(15);
    expect(r.roll.dice.map((d) => d.value)).toEqual([
      1, 6, 6, 7, 2, 8, 1, 5, 6,
    ]);
    expect(r.roll.dice.map((d) => d.id)).toEqual(
      f.parent.dice.map((d) => d.id),
    );
    expect(f.rng).toHaveBeenCalledTimes(4);
    expect(r.rerolledDiceIds).toEqual(
      [1, 3, 4, 7].map((i) => f.parent.dice[i]!.id),
    );
    expect(r.faceOutcomes).toEqual([
      { groupId: "gear", face: 1, combinedCount: 1, rerolledCount: 0 },
    ]);
    expect(
      r.roll.breakdown!.terms.find((t) => t.id === r.roll.breakdown!.rootId)!
        .value,
    ).toBe(15);
    expect(f.parent).toEqual(before);
  });
  it.each(["exhausted", "success", "locked", "empty", "corrupt"])(
    "rejects %s without any child random draws",
    (kind) => {
      const f = fixture();
      if (kind === "exhausted") f.attempt = 2;
      if (kind === "success") f.policy.allowOnSuccess = false;
      if (kind === "locked")
        f.policy.groups.forEach(
          (g) =>
            (g.lockedFaces = [1, 2, 3, 4, 5, 6, 7, 8].filter(
              (v) => v <= (g.groupId === "skill" ? 8 : 6),
            )),
        );
      if (kind === "empty") {
        f.bindings.fields = { attribute: 0, skill: 0, gear: 0 };
        const p = evaluate(f.expression, f.bindings);
        if (!p.ok || !p.roll) throw Error("empty");
        f.parent = p.roll;
      }
      if (kind === "corrupt") f.parent.dice[0]!.id = "forged";
      expect(evaluatePush(f).ok).toBe(false);
      expect(f.rng).not.toHaveBeenCalled();
    },
  );
  it("counts a newly reported face and locks newly rolled successes on the next push", () => {
    const f = fixture();
    f.rng = vi.fn(() => 0.01);
    const r = evaluatePush(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.faceOutcomes[0]).toEqual({
      groupId: "gear",
      face: 1,
      combinedCount: 2,
      rerolledCount: 1,
    });
    f.parent = r.roll;
    f.attempt = 1;
    const next = evaluatePush(f);
    expect(next.ok).toBe(true);
    expect(f.rng).toHaveBeenCalledTimes(6);
  });
});
