import { describe, expect, it } from "vitest";
import { advancedD20Document } from "../package/fixtures/advanced-d20.js";
import { compileExtensionDocument } from "./compile-extension.js";
import { composeRules } from "./compose.js";
import { initializeState } from "../runtime/state.js";
import { resolveObservedValues } from "../runtime/resolve.js";
import { buildCharacterProjection } from "../runtime/projection.js";
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

/** Roadwardens with a computed field on its armor template: twice the weight of one unit. */
function bulkDocument() {
  const doc = advancedD20Document();
  doc.templates[0]!.fields.push({ kind: "computed", id: "bulk", label: "Bulk", valueType: "number", expressionId: "bulk_expr" });
  doc.expressions.push({ id: "bulk_expr", context: "computed", resultType: "number", fallback: 0, source: "item.weight * 2" });
  doc.expressions.find(expression => expression.id === "carried_expr")!.source = 'sum("equipment", "bulk")';
  return doc;
}

it("sums a computed template field over a slot and returns it with the entry", () => {
  const compiled = compileDocument(bulkDocument(), ids);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const entity = compiled.value.entities[0]!;
  const state = initializeState(entity, {});
  if (!state.ok) throw Error("Roadwardens must initialize");
  const entry = (entryId: string, weight: number) => ({ entryId, slotId: "equipment", templateId: "leather", values: { armor: 2, weight, equipped: true }, quantity: 3 });
  state.value.entries = { a: entry("a", 3), b: entry("b", 5) };
  const observed = resolveObservedValues(compiled.value, entity, state.value);
  // A computed field is not per unit, so the quantity does not multiply it.
  expect(observed).toMatchObject({ ok: true, value: { derivedValues: { carried: 16 } } });
  const projection = buildCharacterProjection({ packageValue: compiled.value, entity, state: state.value, derivedValues: {}, validations: [] });
  const slot = projection.sheets.flatMap(sheet => sheet.sections.flatMap(section => section.elements)).find(element => element.kind === "slot");
  expect(slot).toMatchObject({ entries: [
    { entryId: "a", derived: [{ id: "bulk", label: "Bulk", value: 6 }] },
    { entryId: "b", derived: [{ id: "bulk", label: "Bulk", value: 10 }] },
  ] });
});

it("charges a computed template field read by an aggregate for every entry the slot can hold", () => {
  const doc = bulkDocument();
  expect(compileDocument(doc, ids).ok).toBe(true);
  // 200 entries, each evaluating a three-node formula, 14 times: over the 8,192-step sheet budget.
  doc.slots[0]!.maxEntries = 200;
  doc.expressions.find(expression => expression.id === "carried_expr")!.source = Array.from({ length: 14 }, () => 'sum("equipment", "bulk")').join("+");
  expect(compileDocument(doc, ids)).toMatchObject({ ok: false, diagnostics: [{ path: "/entities/0/fields", code: "limit_exceeded" }] });
  doc.expressions.find(expression => expression.id === "carried_expr")!.source = Array.from({ length: 14 }, () => 'sum("equipment", "weight")').join("+");
  expect(compileDocument(doc, ids).ok).toBe(true);
});

it("rejects a system whose compiled package exceeds the size limit", () => {
  const doc = advancedD20Document();
  doc.referenceData.push({
    id: "lore", label: "Lore",
    records: Array.from({ length: 530 }, (_, index) => ({ id: `entry_${index}`, label: `Entry ${index}`, values: { text: "x".repeat(10_000) } })),
  });
  expect(compileDocument(doc, ids)).toMatchObject({ ok: false, diagnostics: [{ code: "limit_exceeded", path: "" }] });
  doc.referenceData.at(-1)!.records.length = 100;
  expect(compileDocument(doc, ids).ok).toBe(true);
});

it("calculates a template resource maximum from the entry and the character's stored fields", () => {
  const doc = advancedD20Document();
  const leather = doc.templates[0]!;
  leather.fields.push({ kind: "resource", id: "charges", label: "Charges", default: { current: 0, max: 0 }, min: 0, max: 20, step: 1, resetTo: "max", maxExpressionId: "charges_max", startFull: true });
  doc.expressions.push({ id: "charges_max", context: "computed", resultType: "number", fallback: 0, source: "item.armor + fields.level" });
  const compiled = compileDocument(doc, ids);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const entity = compiled.value.entities[0]!;
  const state = initializeState(entity, { level: 3 });
  if (!state.ok) throw Error("Roadwardens must initialize");
  state.value.entries = { a: { entryId: "a", slotId: "equipment", templateId: "leather", values: { armor: 2, weight: 3, equipped: true } } };
  const first = resolveObservedValues(compiled.value, entity, state.value);
  if (!first.ok) throw Error(first.error.message);
  // The maximum rose from 0, so the start-full resource fills.
  expect(first.value.state.entries.a!.values.charges).toEqual({ current: 5, max: 5 });
  first.value.state.entries.a!.values.charges = { current: 1, max: 5 };
  first.value.state.values.level = 1;
  const lowered = resolveObservedValues(compiled.value, entity, first.value.state);
  if (!lowered.ok) throw Error(lowered.error.message);
  expect(lowered.value.state.entries.a!.values.charges).toEqual({ current: 1, max: 3 });
  // A template formula cannot read the character's computed fields.
  doc.expressions.find((expression) => expression.id === "charges_max")!.source = "fields.proficiency_bonus";
  expect(compileDocument(doc, ids)).toMatchObject({ ok: false, diagnostics: [{ code: "missing_reference", path: "charges_max" }] });
});

it("leaves out sections and elements whose condition is false and rejects a non-boolean condition", () => {
  const doc = advancedD20Document();
  doc.entities[0]!.fields.push(
    { kind: "boolean", id: "caster", label: "Caster", default: false, required: false },
    { kind: "computed", id: "veteran", label: "Veteran", valueType: "boolean", expressionId: "veteran_expr" },
  );
  doc.expressions.push({ id: "veteran_expr", context: "computed", resultType: "boolean", fallback: false, source: "fields.level >= 4" });
  const sheet = doc.sheets[0]!;
  sheet.sections.push({ id: "spells_section", label: "Spells", visibleWhen: "caster", elements: [{ kind: "heading", id: "spells_heading", text: "Spells", level: 2 }] });
  sheet.sections[0]!.elements[0]!.visibleWhen = "veteran";
  const compiled = compileDocument(doc, ids);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const entity = compiled.value.entities[0]!;
  const project = (values: Record<string, unknown>) => {
    const state = initializeState(entity, values);
    if (!state.ok) throw Error("must initialize");
    const observed = resolveObservedValues(compiled.value, entity, state.value);
    if (!observed.ok) throw Error(observed.error.message);
    return buildCharacterProjection({ packageValue: compiled.value, entity, state: observed.value.state, derivedValues: observed.value.derivedValues, validations: [] }).sheets[0]!;
  };
  const novice = project({});
  expect(novice.sections.map((section) => section.id)).not.toContain("spells_section");
  expect(novice.sections[0]!.elements.map((element) => element.id)).not.toContain(sheet.sections[0]!.elements[0]!.id);
  const veteran = project({ caster: true, level: 4 });
  expect(veteran.sections.map((section) => section.id)).toContain("spells_section");
  expect(veteran.sections[0]!.elements[0]!.id).toBe(sheet.sections[0]!.elements[0]!.id);
  sheet.sections.at(-1)!.visibleWhen = "level";
  expect(compileDocument(doc, ids)).toMatchObject({ ok: false, diagnostics: [{ code: "invalid_expression" }] });
});
