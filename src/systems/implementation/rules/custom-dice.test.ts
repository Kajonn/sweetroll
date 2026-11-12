import { describe, expect, it } from "vitest";

import { decodeSystemDocument, decodeSystemPackage } from "../package/codec.js";
import { d20Document } from "../package/fixtures/d20.js";
import { compileExpression } from "./compile.js";
import { compileDocument } from "./compile-document.js";
import { evaluate } from "./evaluate.js";
import { parse } from "./parser.js";
import { renderExpression } from "./render.js";
import { formatRollBreakdown } from "./result.js";

const dice = [
  { id: "fudge", label: "Fudge", faces: [{ value: -1, label: "Minus" }, { value: 0, label: "Blank" }, { value: 1, label: "Plus" }] },
  { id: "signal", label: "Signal", faces: [
    { value: 0, label: "Bright", symbols: { hit: 2 } },
    { value: 0, label: "Dim", symbols: { snag: 1 } },
    { value: 0, label: "Still" },
  ] },
];
const options = { env: { fields: {}, inputs: {}, dice }, context: "roll", resultType: "number", fallback: 0 } as const;

function roll(source: string, draws: number[]) {
  const compiled = compileExpression(source, options);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  let index = 0;
  const result = evaluate({ ...compiled.value, id: "test" }, { fields: {}, inputs: {}, dice }, () => {
    if (index >= draws.length) throw new Error("Unexpected extra draw");
    return draws[index++]!;
  });
  expect(index).toBe(draws.length);
  if (!result.ok || result.roll === null) throw new Error(JSON.stringify(result));
  return result.roll;
}

describe("custom dice", () => {
  it("sums the numeric values of four labeled Fudge dice", () => {
    expect(roll('dice(4, "fudge")', [0, 0.5, 0.9, 1])).toMatchObject({
      total: 1,
      dice: [{ value: -1, faceLabel: "Minus" }, { value: 0, faceLabel: "Blank" },
        { value: 1, faceLabel: "Plus" }, { value: 1, faceLabel: "Plus" }],
      breakdown: { groups: [{ dieId: "fudge", count: 4, sides: 3 }] },
    });
  });

  it("counts symbol multiplicities from the same draws even when face values are equal", () => {
    const source = 'countSymbol(group("check", "Check", dice(3, "signal")), "hit") - countSymbol(rolled("check"), "snag")';
    const result = roll(source, [0.1, 0.5, 0.9]);
    expect(result.total).toBe(1);
    expect(result.dice).toMatchObject([{ symbols: { hit: 2 } }, { symbols: { snag: 1 } }, { faceLabel: "Still" }]);
    expect(result.breakdown.groups).toMatchObject([{ operation: "countSymbol", symbol: "hit" }]);
    expect(formatRollBreakdown(result.breakdown, result.dice)).toContain("Bright");
    const parsed = parse(source);
    expect(parsed.ok && parse(renderExpression(parsed.ast))).toEqual(parsed);
  });

  it("matches modifier faces by numeric value and counts symbols from final chains", () => {
    const result = roll('countSymbol(rerollOnce(dice(1, "signal"), 0), "hit")', [0.1, 0.9]);
    expect(result.total).toBe(0);
    expect(result.dice).toMatchObject([{ kept: false, faceLabel: "Bright" }, { kept: true, faceLabel: "Still" }]);
  });

  it("rejects unknown dice, invalid symbol IDs and dice in computed expressions", () => {
    for (const source of ['dice(1, "missing")', 'countSymbol(d6, "Bad ID")', 'countSymbol(d6, fields.symbol)']) {
      expect(compileExpression(source, options)).toMatchObject({ ok: false });
    }
    expect(compileExpression('dice(1, "fudge")', { ...options, context: "computed" })).toMatchObject({ ok: false });
  });

  it("validates bounded definitions and keeps them in the signed package", () => {
    const document = { ...d20Document, dice };
    expect(decodeSystemDocument({ ...document, dice: [...dice, dice[0]] })).toMatchObject({
      ok: false, diagnostics: [{ code: "duplicate_definition_id", path: "/dice/2/id" }],
    });
    for (const faces of [[], Array(21).fill({ value: 0 }), [{ value: 0, symbols: { hit: -1 } }]]) {
      expect(decodeSystemDocument({ ...document, dice: [{ ...dice[0], faces }] }).ok).toBe(false);
    }
    const decoded = decodeSystemDocument(document);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const compiled = compileDocument(decoded.value, {
      systemId: "00000000-0000-4000-8000-000000000000",
      versionId: "00000000-0000-4000-8000-000000000001",
      semanticVersion: "1.0.0",
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(decodeSystemPackage(compiled.value)).toMatchObject({ ok: true, value: { dice } });
  });
});
