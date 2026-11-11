import { describe, expect, it } from "vitest";
import { advancedD20Document } from "../package/fixtures/advanced-d20.js";
import { compileExtensionDocument } from "./compile-extension.js";
import { composeRules } from "./compose.js";
import { initializeState } from "../runtime/state.js";
import { checkVersionChange } from "../runtime/version-change.js";
import { d20Document, d20Package } from "../package/fixtures/d20.js";
import { comparePackages } from "../package/compatibility.js";
import { decodeSystemDocument } from "../package/codec.js";
import { compileDocument } from "./compile-document.js";
import { compileExpression } from "./compile.js";
import { evaluate } from "./evaluate.js";

const ids = { systemId: d20Package.systemId, versionId: d20Package.versionId, semanticVersion: "2.0.0" };
const dataset = {
  id: "levels", label: "Levels", keyColumn: "level", columns: { level: "number", bonus: "number" },
  records: [
    { id: "rookie", label: "Rookie", values: { level: 1, bonus: 2 } },
    { id: "expert", label: "Expert", values: { level: 4, bonus: 3 } },
  ],
} as const;

describe("rules data", () => {
  it("allows two entities to own the same field and resolves validation within one owner", () => {
    const doc = structuredClone(d20Document);
    doc.validations[0]!.targetEntityId = "character";
    doc.entities.push({ id: "rival", label: "Rival", fields: [{ ...doc.entities[0]!.fields[0]! }] });
    expect(decodeSystemDocument(doc).ok).toBe(true);
    expect(compileDocument(doc, ids).ok).toBe(true);
  });

  it("compares fields within the correct owner even when their IDs match", () => {
    const original = structuredClone(d20Package);
    original.entities.push({ id: "rival", label: "Rival", fields: [structuredClone(original.entities[0]!.fields[0]!)] });
    const next = structuredClone(original);
    next.entities[1]!.fields = [];
    expect(comparePackages(original, next).findings).toMatchObject([
      { path: "/entities/rival/fields/ability", code: "breaking_removed_definition" },
    ]);
  });

  it.each([
    ['lookup("levels", 4, "bonus")', 3],
    ['lookupBand("levels", 3, "bonus")', 2],
    ['lookupBand("levels", 0, "bonus")', -1],
    ['sumWhere("equipment", "armor", "equipped") + maxOf("equipment", "armor")', 5],
    ['sum("equipment", "weight")', 11],
    ['count("equipment") + countWhere("equipment", "equipped")', 3],
    ['item.armor + fields.armor', 9],
  ])("evaluates %s", (source, value) => {
    const env = {
      fields: { armor: "number" }, inputs: {}, item: { armor: "number" },
      datasets: [dataset],
      slots: { equipment: { capacity: 10, fields: { armor: "number", weight: "number", equipped: "boolean" } } },
    } as const;
    const compiled = compileExpression(source, { env, resultType: "number", fallback: -1, context: "computed" });
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const result = evaluate({ id: "data", ...compiled.value }, {
      fields: { armor: 5 }, inputs: {}, item: { armor: 4 },
      datasets: [dataset],
      slotEntries: () => [
        // Two units: weight is per unit, the armor bonus counts once.
        { values: { armor: 2, weight: 4, equipped: true }, quantity: 2, quantityFields: new Set(["weight"]) },
        { values: { armor: 3, weight: 3, equipped: false }, quantity: 1, quantityFields: new Set(["weight"]) },
      ],
    });
    expect(result).toMatchObject({ ok: true, result: value });
  });
});

it("rejects an ambiguous validation target until its owner is selected", () => {
  const doc = structuredClone(d20Document);
  const { targetEntityId: _owner, ...unqualified } = doc.validations[0]!;
  doc.validations[0] = unqualified;
  doc.entities.push({ id: "rival", label: "Rival", fields: [structuredClone(doc.entities[0]!.fields[0]!)] });
  expect(decodeSystemDocument(doc)).toMatchObject({
    ok: false, diagnostics: [{ path: "/validations/0/targetId", code: "missing_reference" }],
  });
});

it("rejects duplicate table keys at publication and cyclic resource maxima", () => {
  const doc = advancedD20Document();
  doc.referenceData[0]!.records[1]!.values.level = 1;
  expect(compileDocument(doc, ids)).toMatchObject({
    ok: false, diagnostics: [{ path: "/referenceData/0/records/1/values/level" }],
  });
  doc.referenceData[0]!.records[1]!.values.level = 4;
  doc.expressions.find(expression => expression.id === "health_max")!.source = "fields.health.max";
  expect(compileDocument(doc, ids)).toMatchObject({
    ok: false, diagnostics: [{ path: "health_max", code: "invalid_expression" }],
  });
});

it("checks worst-case slot scans against the sheet evaluation budget", () => {
  const doc = advancedD20Document();
  doc.slots[0]!.maxEntries = 200;
  const group = Array.from({ length: 7 }, () => 'count("equipment")').join("+");
  const source = Array.from({ length: 6 }, () => `(${group})`).join("+");
  doc.expressions.find(expression => expression.id === "carried_expr")!.source = source;
  expect(compileDocument(doc, ids)).toMatchObject({
    ok: false, diagnostics: [{ path: "/entities/0/fields", code: "limit_exceeded" }],
  });
});

it("rejects extension templates that change a field type used by an aggregate", () => {
  const base = compileDocument(advancedD20Document(), ids);
  if (!base.ok) throw Error(JSON.stringify(base.diagnostics));
  const extension = compileExtensionDocument({
    schemaVersion: "2.0", metadata: { name: "Outfitter", description: "", language: "en" },
    expressions: [], templates: [{
      id: "brass_armor", label: "Brass armor", kind: "item", grantedActions: [],
      fields: [{ kind: "text", id: "armor", label: "Armor", default: "", required: false, minLength: 0, maxLength: 32 }],
    }],
  }, base.value, {
    extensionId: "00000000-0000-4000-8000-000000000099", versionId: "00000000-0000-4000-8000-000000000098", semanticVersion: "1.0.0",
  });
  if (!extension.ok) throw Error(JSON.stringify(extension.diagnostics));
  expect(composeRules(base.value, [extension.value.package])).toMatchObject({
    ok: false, diagnostics: [{ code: "extension_incompatible" }],
  });
});

it("recomputes the maximum from the target table during a version dry run", () => {
  const doc = advancedD20Document();
  const from = compileDocument(doc, ids);
  doc.referenceData[0]!.records[1]!.values.health = 14;
  const to = compileDocument(doc, { ...ids, versionId: "00000000-0000-4000-8000-000000000098", semanticVersion: "2.1.0" });
  if (!from.ok || !to.ok) throw Error("Roadwardens must compile");
  const state = initializeState(from.value.entities[0]!, { level: 4, health: { current: 17, max: 18 } });
  if (!state.ok) throw Error("Roadwardens must initialize");
  expect(checkVersionChange({ from: from.value, to: to.value, entityId: "character", state: state.value, direction: "upgrade" }))
    .toMatchObject({ ok: true, nextState: { values: { health: { current: 14, max: 14 } } } });
});
