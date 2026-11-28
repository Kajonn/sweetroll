import { describe, expect, it } from "vitest";
import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { renderExpression } from "./render.js";

const source =
  'countSuccesses(group("attribute", "Attribute", dice(fields.attribute + inputs.bonus, 6)), 6) + 2 * countSuccesses(group("skill", "Skill", dice(fields.skill, 8)), 5) + group("gear", "Gear", dice(fields.gear, 4))';
const opts = {
  env: {
    fields: { attribute: "number", skill: "number", gear: "number" },
    inputs: { bonus: "number" },
  },
  resultType: "number",
  context: "roll",
  fallback: 0,
} as const;

describe("grammar 0.2 named groups", () => {
  it("keeps three groups, an empty group, mixed count/sum and nested operations under exact RNG", () => {
    const compiled = compileExpression(source, opts);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(renderExpression(compiled.value.ast)).toBe(source);
    let calls = 0;
    const rng = [1, 0.1, 0.7];
    const result = evaluate(
      { id: "test", ...compiled.value },
      { fields: { attribute: 1, skill: 1, gear: 0 }, inputs: { bonus: 1 } },
      () => rng[calls++]!,
    );
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roll?.total).toBe(3);
    expect(
      result.roll?.breakdown?.groups.map((g) => ({
        id: g.id,
        count: g.count,
        operation: g.operation,
        threshold: g.threshold,
        total: g.total,
      })),
    ).toEqual([
      {
        id: "attribute",
        count: 2,
        operation: "countAtLeast",
        threshold: 6,
        total: 1,
      },
      {
        id: "skill",
        count: 1,
        operation: "countAtLeast",
        threshold: 5,
        total: 1,
      },
      {
        id: "gear",
        count: 0,
        operation: "sum",
        threshold: undefined,
        total: 0,
      },
    ]);
    expect(result.roll?.dice).toEqual([
      {
        id: "attribute:0",
        groupId: "attribute",
        sides: 6,
        value: 6,
        kept: true,
        success: true,
      },
      {
        id: "attribute:1",
        groupId: "attribute",
        sides: 6,
        value: 1,
        kept: true,
        success: false,
      },
      {
        id: "skill:0",
        groupId: "skill",
        sides: 8,
        value: 6,
        kept: true,
        success: true,
      },
    ]);
    const breakdown = result.roll!.breakdown!;
    expect(breakdown.version).toBe("1.0");
    expect(
      breakdown.terms.find((t) => t.id === breakdown.rootId),
    ).toMatchObject({ operation: "+", value: 3 });
    expect(breakdown.terms.find((t) => t.operation === "*")).toMatchObject({
      value: 2,
    });
  });
  it("rejects duplicate IDs and non-deterministic counts", () => {
    expect(
      compileExpression('group("x", "X", d6) + group("x", "Again", d6)', opts)
        .ok,
    ).toBe(false);
    expect(compileExpression('group("x", "X", dice(d6, 6))', opts).ok).toBe(
      false,
    );
  });
  it("enforces one total budget across groups and rejects invalid counts", () => {
    const compiled = compileExpression(source, opts);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = (attribute: number) =>
      evaluate(
        { id: "test", ...compiled.value },
        { fields: { attribute, skill: 1, gear: 0 }, inputs: { bonus: 0 } },
        () => 1,
        { dicePerRoll: 2, sidesPerDie: 8 },
      );
    expect(run(2).ok).toBe(false);
    const negative = run(-1);
    expect(negative.ok && negative.diagnostics[0]?.code).toBe(
      "arithmetic_failure",
    );
  });
  it("records a graph for unnamed pools and preserves deterministic draw order", () => {
    const compiled = compileExpression("2d6kh1 + d4", {
      ...opts,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    let calls = 0;
    const rng = [1, 0.1, 0.5];
    const result = evaluate(
      { id: "old", ...compiled.value },
      { fields: {}, inputs: {} },
      () => rng[calls++]!,
    );
    expect(calls).toBe(3);
    expect(result.ok && result.roll).toMatchObject({
      total: 8,
      expression: "2d6kh1 + d4",
      breakdown: { groups: [{ id: "@root.0" }, { id: "@root.1" }] },
      dice: [
        { sides: 6, value: 6, kept: true },
        { sides: 6, value: 1, kept: false },
        { sides: 4, value: 2, kept: true },
      ],
    });
  });
  it("retains grouped kept and discarded dice without changing tie order", () => {
    const compiled = compileExpression('group("gear", "Gear", 3d6kh1)', opts);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(renderExpression(compiled.value.ast)).toBe(
      'group("gear", "Gear", 3d6kh1)',
    );
    const result = evaluate(
      { id: "keep", ...compiled.value },
      { fields: {}, inputs: {} },
      () => 1,
    );
    expect(result.ok && result.roll?.dice.map((d) => d.kept)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("one group name in each branch of a conditional (SRD gaps S8)", () => {
  const env = { fields: { mod: "number" }, inputs: { advantage: "boolean", disadvantage: "boolean" } } as const;
  const d20 = 'if(inputs.disadvantage && !inputs.advantage, keepLowest(group("d20", "d20", dice(2, 20)), 1), '
    + 'keepHighest(group("d20", "d20", dice(if(inputs.advantage && !inputs.disadvantage, 2, 1), 20)), 1)) + fields.mod';
  const compile = (source: string) => compileExpression(source, { env, resultType: "number", context: "roll", fallback: 0 });

  it.each([
    [{ advantage: false, disadvantage: true }, [0.3, 0.9], 2, 7],
    [{ advantage: true, disadvantage: false }, [0.3, 0.9], 2, 19],
    [{ advantage: false, disadvantage: false }, [0.3], 1, 7],
  ])("rolls and keeps the d20 for %o without a zero-weighted term", (inputs, draws, count, total) => {
    const compiled = compile(d20);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    let call = 0;
    const result = evaluate({ id: "check", ...compiled.value }, { fields: { mod: 1 }, inputs }, () => draws[call++]!);
    expect(result).toMatchObject({ ok: true, result: total });
    if (!result.ok) return;
    expect(result.roll?.breakdown.groups).toEqual([expect.objectContaining({ id: "d20", count })]);
  });

  it("makes a group named on every branch available afterwards, and only then", () => {
    expect(compile('if(inputs.advantage, group("a", "A", d20), group("a", "A", d6)) + rolled("a")').ok).toBe(true);
    expect(compile('if(inputs.advantage, group("a", "A", d20), d6) + rolled("a")')).toMatchObject({ ok: false });
    expect(compile('group("a", "A", d20) + group("a", "A", d6)')).toMatchObject({ ok: false });
    expect(compile('if(inputs.advantage, group("a", "A", d20), d6) + group("a", "A", d6)')).toMatchObject({ ok: false });
  });
});
