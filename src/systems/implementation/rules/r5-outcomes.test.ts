import { describe, expect, it } from "vitest";

import { d20Document, pbta2d6Document } from "../package/fixtures/index.js";
import type { SystemDocumentV1 } from "../package/schema/index.js";
import { compileDocument } from "./compile-document.js";
import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";
import { describeRoll } from "./outcomes.js";

const ids = { systemId: "a0000000-0000-5000-8000-000000000001", versionId: "a0000000-0000-5000-8000-000000000002", semanticVersion: "1.0.0" };
const env = { fields: { skill: "number", name: "text" }, inputs: { bonus: "number" } } as const;

function describe_(input: {
  roll: string; faces: number[]; sides: number; template: string;
  outcomes?: Array<[id: string, label: string, source: string]>;
  details?: Array<[id: string, label: string, source: string]>;
  fields?: Record<string, number | string>;
}) {
  const rollCompiled = compileExpression(input.roll, { env: env as never, resultType: "number", context: "roll", fallback: 0 });
  if (!rollCompiled.ok) throw new Error(JSON.stringify(rollCompiled.diagnostics));
  const groups = [...input.roll.matchAll(/group\("([a-z_]+)"/g)].map((match) => match[1]!);
  const expressions = new Map<string, ReturnType<typeof compileOutcome>>();
  function compileOutcome(source: string, resultType: "boolean" | "number") {
    const compiled = compileExpression(source, {
      env: { ...env, roll: { total: "number" } } as never, resultType, context: "outcome", rolledGroups: groups,
      fallback: resultType === "boolean" ? false : 0,
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return { id: source, ...compiled.value };
  }
  const entries = (list: Array<[string, string, string]> | undefined, type: "boolean" | "number") => list?.map(([id, label, source]) => {
    expressions.set(source, compileOutcome(source, type));
    return { id, label, expressionId: source };
  });
  const action = {
    outputTemplate: input.template,
    ...(input.outcomes ? { outcomes: entries(input.outcomes, "boolean")! } : {}),
    ...(input.details ? { details: entries(input.details, "number")! } : {}),
  };
  const bindings = { fields: { skill: 60, name: "Aria", ...input.fields }, inputs: { bonus: 1 } };
  const faces = [...input.faces];
  const evaluated = evaluate({ id: "roll", ...rollCompiled.value }, bindings, () => (faces.shift()! - 0.5) / input.sides);
  if (!evaluated.ok || evaluated.roll === null) throw new Error("roll failed");
  return describeRoll({
    action, expression: (id) => expressions.get(id), total: evaluated.roll.total, bindings, rolled: evaluated.rolled,
    limits: { dicePerRoll: 100, sidesPerDie: 1000 },
  });
}

const bands: Array<[string, string, string]> = [
  ["strong", "Strong hit", "roll.total >= 10"],
  ["weak", "Weak hit", "roll.total >= 7"],
  ["miss", "Miss", "true"],
];

describe("roll outcomes (rules coverage R5)", () => {
  it.each([
    [[6, 5], "strong", "Result: 12 — Strong hit"],
    [[3, 4], "weak", "Result: 8 — Weak hit"],
    [[1, 2], "miss", "Result: 4 — Miss"],
  ])("names the first band that holds for 2d6+1 rolled as %j", (faces, id, output) => {
    const result = describe_({ roll: "2d6 + inputs.bonus", faces, sides: 6, template: "Result: {total}", outcomes: bands });
    expect(result.outcome?.id).toBe(id);
    expect(result.output).toBe(output);
  });

  it("places the outcome and other values where the template asks", () => {
    const result = describe_({
      roll: "2d6 + inputs.bonus", faces: [3, 4], sides: 6, outcomes: bands,
      template: "{fields.name}: {outcome} ({total}, bonus {inputs.bonus})",
    });
    expect(result.output).toBe("Aria: Weak hit (8, bonus 1)");
  });

  it("reports no outcome when no band holds and leaves the placeholder empty", () => {
    const result = describe_({
      roll: "d20", faces: [3], sides: 20, template: "{total} {outcome}",
      outcomes: [["crit", "Critical", "roll.total == 20"]],
    });
    expect(result.outcome).toBeUndefined();
    expect(result.output).toBe("3 ");
  });

  it("grades a d100 roll-under with doubles as criticals and a success-level detail", () => {
    const percentile = (face: number, skill = 60) => describe_({
      roll: 'group("percent", "Percent", d100)', faces: [face], sides: 100, fields: { skill },
      template: "{total} vs {fields.skill}: {outcome}, {detail.levels} levels",
      outcomes: [
        ["critical", "Critical", 'roll.total <= fields.skill && floor(rolled("percent") / 10) == rolled("percent") % 10'],
        ["success", "Success", "roll.total <= fields.skill"],
        ["fumble", "Fumble", 'floor(rolled("percent") / 10) == rolled("percent") % 10'],
        ["failure", "Failure", "true"],
      ],
      details: [["levels", "Success levels", "floor(fields.skill / 10) - floor(roll.total / 10)"]],
    });
    expect(percentile(33)).toMatchObject({ outcome: { id: "critical" }, details: [{ id: "levels", label: "Success levels", value: 3 }] });
    expect(percentile(41).outcome?.id).toBe("success");
    expect(percentile(88).outcome?.id).toBe("fumble");
    expect(percentile(71)).toMatchObject({ outcome: { id: "failure" }, output: "71 vs 60: Failure, -1 levels" });
  });

  it("records the values an outcome read that the roll did not", () => {
    const result = describe_({ roll: "d100", faces: [50], sides: 100, template: "{total}", outcomes: [["ok", "Success", "roll.total <= fields.skill"]] });
    expect(result.bindings).toEqual([{ scope: "fields", definitionId: "skill", value: 60 }]);
  });

  it.each([
    ["d6 > 3", "cannot roll new dice"],
    ['rolled("missing") > 3', "must be rolled before"],
    ["roll.nope > 3", "unknown roll reference"],
  ])("rejects the outcome condition %s", (source, message) => {
    const compiled = compileExpression(source, {
      env: { ...env, roll: { total: "number" } } as never, resultType: "boolean", context: "outcome", rolledGroups: ["percent"], fallback: false,
    });
    expect(compiled.ok ? "accepted" : compiled.diagnostics.map((d) => d.message).join("; ")).toContain(message);
  });

  it("does not let a roll formula read its own result", () => {
    const compiled = compileExpression("d20 + roll.total", { env: env as never, resultType: "number", context: "roll", fallback: 0 });
    expect(compiled.ok).toBe(false);
  });
});

describe("outcomes in documents", () => {
  function withBands(change: (document: SystemDocumentV1) => void = () => {}): SystemDocumentV1 {
    const document = structuredClone(pbta2d6Document);
    const action = document.actions.find((candidate) => candidate.kind === "roll")!;
    if (action.kind !== "roll") throw new Error("fixture");
    action.outcomes = bands.map(([id, label]) => ({ id, label, expressionId: `band_${id}` }));
    action.details = [{ id: "margin", label: "Margin", expressionId: "detail_margin" }];
    action.outputTemplate = "{outcome}: {total} (margin {detail.margin})";
    document.expressions.push(
      ...bands.map(([id, , source]) => ({ id: `band_${id}`, context: "outcome" as const, resultType: "boolean" as const, source, fallback: false })),
      { id: "detail_margin", context: "outcome", resultType: "number", source: "roll.total - 7", fallback: 0 },
    );
    change(document);
    return document;
  }
  const firstDiagnostic = (document: SystemDocumentV1) => {
    const result = compileDocument(document, ids);
    return result.ok ? "accepted" : `${result.diagnostics[0]!.path}: ${result.diagnostics[0]!.message}`;
  };

  it("compiles outcome bands and details with their roll", () => {
    const result = compileDocument(withBands(), ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expressions.filter((expression) => expression.context === "outcome")).toHaveLength(4);
  });

  it.each<[string, (document: SystemDocumentV1) => void, string]>([
    ["a number as a band condition", (d) => { d.expressions.find((e) => e.id === "band_miss")!.resultType = "number"; }, "must be true or false"],
    ["a condition as a detail", (d) => { d.expressions.find((e) => e.id === "detail_margin")!.resultType = "boolean"; }, "must be a number"],
    ["an unused outcome expression", (d) => { d.expressions.push({ id: "stray", context: "outcome", resultType: "boolean", source: "true", fallback: false }); }, "must be used by one outcome"],
    ["a shared outcome expression", (d) => { const a = d.actions.find((c) => c.kind === "roll")!; if (a.kind === "roll") a.outcomes![1]!.expressionId = "band_strong"; }, "cannot be shared"],
    ["a roll formula as a band", (d) => { const a = d.actions.find((c) => c.kind === "roll")!; if (a.kind === "roll") a.outcomes![0]!.expressionId = a.expressionId; }, "of the outcome kind"],
    ["an unknown placeholder", (d) => { const a = d.actions.find((c) => c.kind === "roll")!; if (a.kind === "roll") a.outputTemplate = "{damage}"; }, "not a known placeholder"],
    ["a missing detail placeholder", (d) => { const a = d.actions.find((c) => c.kind === "roll")!; if (a.kind === "roll") a.outputTemplate = "{detail.nope}"; }, "does not name a detail"],
    ["an unknown field placeholder", (d) => { const a = d.actions.find((c) => c.kind === "roll")!; if (a.kind === "roll") a.outputTemplate = "{fields.nope}"; }, "does not name a value"],
  ])("rejects %s", (_name, change, message) => {
    expect(firstDiagnostic(withBands(change))).toContain(message);
  });

  it("rejects {outcome} on an action without outcomes and keeps plain templates valid", () => {
    const plain = structuredClone(d20Document);
    expect(compileDocument(plain, ids).ok).toBe(true);
    const action = plain.actions.find((candidate) => candidate.kind === "roll")!;
    if (action.kind === "roll") action.outputTemplate = "{outcome}";
    expect(firstDiagnostic(plain)).toContain("needs at least one outcome");
  });
});
