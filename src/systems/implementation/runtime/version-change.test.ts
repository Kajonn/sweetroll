import { describe, expect, it } from "vitest";

import { compileDocument } from "../rules/compile-document.js";
import { validDocument } from "../package/schema/test-values.js";
import type { CharacterEntryV1, ObjectTemplateV1, SystemDocumentV1, SystemPackageV1 } from "../package/schema/index.js";
import { initializeState } from "./state.js";
import { checkVersionChange } from "./version-change.js";

const SYSTEM_ID = "00000000-0000-4000-8000-000000000001";
const V1 = "00000000-0000-4000-8000-000000000011";
const V2 = "00000000-0000-4000-8000-000000000012";
const SWORD = "aaaaaaaa-1111-4111-8111-111111111111";
const SHIELD = "bbbbbbbb-2222-4222-8222-222222222222";

function sword(overrides: Partial<ObjectTemplateV1> = {}): ObjectTemplateV1 {
  return {
    id: "longsword",
    label: "Longsword",
    kind: "item",
    fields: [
      { kind: "integer", id: "weapon_bonus", label: "Bonus", default: 1, required: true, min: 0, max: 10, step: 1 },
      { kind: "integer", id: "weight", label: "Weight", default: 3, required: false, min: 0, max: 20, step: 1 },
    ],
    grantedActions: [{
      kind: "roll",
      id: "longsword_attack",
      label: "Attack",
      expressionId: "longsword_attack_expr",
      inputs: [],
      outputTemplate: "Longsword: {total}",
    }],
    ...overrides,
  };
}

function baseDocument(): SystemDocumentV1 {
  const document = validDocument();
  document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
  document.templates = [sword()];
  document.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
  document.sheets[0]!.sections[0]!.elements.push({ kind: "slot", id: "inventory_element", slotId: "inventory" });
  document.expressions.push({
    id: "longsword_attack_expr",
    context: "roll",
    resultType: "number",
    source: "d20 + fields.weapon_bonus",
    fallback: 0,
  });
  return document;
}

function compile(document: SystemDocumentV1, versionId: string, semanticVersion: string): SystemPackageV1 {
  const result = compileDocument(document, { systemId: SYSTEM_ID, versionId, semanticVersion });
  if (!result.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}

function swordEntry(values: Record<string, unknown> = { weapon_bonus: 1, weight: 3 }): CharacterEntryV1 {
  return { entryId: SWORD, slotId: "inventory", templateId: "longsword", source: { kind: "system", templateId: "longsword" }, values };
}

function characterState(pkg: SystemPackageV1, entries: Record<string, CharacterEntryV1>) {
  const entity = pkg.entities.find((e) => e.id === "character")!;
  const initialized = initializeState(entity, { name: "Hero" });
  if (!initialized.ok) throw new Error(initialized.error.message);
  return { ...initialized.value, entries };
}

describe("checkVersionChange", () => {
  const v1 = compile(baseDocument(), V1, "1.0.0");

  it("upgrades across additive changes and follows unchanged item stats", () => {
    const next = baseDocument();
    next.templates = [
      sword({ fields: [
        { kind: "integer", id: "weapon_bonus", label: "Bonus", default: 2, required: true, min: 0, max: 10, step: 1 },
        { kind: "integer", id: "weight", label: "Weight", default: 4, required: false, min: 0, max: 20, step: 1 },
        { kind: "integer", id: "reach", label: "Reach", default: 1, required: false, min: 0, max: 5, step: 1 },
      ] }),
      { id: "shield", label: "Shield", kind: "item", fields: [], grantedActions: [] },
    ];
    next.entities[0]!.fields.push({ kind: "integer", id: "luck", label: "Luck", default: 5, required: false, min: 0, max: 10, step: 1 });
    const v2 = compile(next, V2, "1.1.0");
    // weight was changed by the player; weapon_bonus still matches the old default.
    const state = characterState(v1, { [SWORD]: swordEntry({ weapon_bonus: 1, weight: 7 }) });

    const report = checkVersionChange({ from: v1, to: v2, entityId: "character", state, direction: "upgrade" });

    expect(report.blockers).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.addedFields).toEqual(["luck"]);
    expect(report.changedEntries).toEqual([{
      entryId: SWORD, templateId: "longsword", updatedFields: ["weapon_bonus"], keptFields: ["weight"],
      addedFields: ["reach"], droppedFields: [], imageUpdated: false,
    }]);
    expect(report.nextState!.values.luck).toBe(5);
    expect(report.nextState!.values.name).toBe("Hero");
    expect(report.nextState!.entries![SWORD]!.values).toEqual({ weapon_bonus: 2, weight: 7, reach: 1 });
  });

  it("re-pins campaign-derived entries and keeps campaign overrides", () => {
    const next = baseDocument();
    next.templates = [sword({ fields: [
      { kind: "integer", id: "weapon_bonus", label: "Bonus", default: 2, required: true, min: 0, max: 10, step: 1 },
      { kind: "integer", id: "weight", label: "Weight", default: 4, required: false, min: 0, max: 20, step: 1 },
    ] })];
    const v2 = compile(next, V2, "1.1.0");
    const derived: CharacterEntryV1 = {
      entryId: SWORD,
      slotId: "inventory",
      templateId: null,
      source: { kind: "campaign", campaignId: "cccccccc-3333-4333-8333-333333333333", templateId: "dddddddd-4444-4444-8444-444444444444", templateRevision: 1, contentRevision: 1 },
      snapshot: {
        kind: "item",
        values: { name: "Family blade", description: "", notes: "" },
        base: { versionId: v1.versionId, packageChecksum: v1.integrity.checksum, templateId: "longsword" },
        defaultValues: { weapon_bonus: 4, weight: 3 },
      },
      values: { weapon_bonus: 4, weight: 3 },
    };
    const report = checkVersionChange({ from: v1, to: v2, entityId: "character", state: characterState(v1, { [SWORD]: derived }), direction: "upgrade" });

    expect(report.blockers).toEqual([]);
    const moved = report.nextState!.entries![SWORD]!;
    expect(moved.values).toEqual({ weapon_bonus: 4, weight: 4 });
    expect(moved.snapshot).toMatchObject({
      base: { versionId: v2.versionId, packageChecksum: v2.integrity.checksum, templateId: "longsword" },
      defaultValues: { weapon_bonus: 4, weight: 4 },
    });
  });

  it("blocks an upgrade with breaking package changes", () => {
    const next = baseDocument();
    next.templates = [sword({ fields: [sword().fields[0]!] })];
    const v2 = compile(next, V2, "2.0.0");
    const report = checkVersionChange({ from: v1, to: v2, entityId: "character", state: characterState(v1, {}), direction: "upgrade" });
    expect(report.ok).toBe(false);
    expect(report.nextState).toBeNull();
    expect(report.blockers).toContainEqual(expect.objectContaining({ code: "breaking_change", definitionId: "/templates/longsword/fields/weight" }));
  });

  it("blocks when a kept value is outside a narrowed range", () => {
    const next = baseDocument();
    next.templates = [sword({ fields: [
      { kind: "integer", id: "weapon_bonus", label: "Bonus", default: 1, required: true, min: 0, max: 3, step: 1 },
      sword().fields[1]!,
    ] })];
    const v2 = compile(next, V2, "1.1.0");
    const state = characterState(v1, { [SWORD]: swordEntry({ weapon_bonus: 8, weight: 3 }) });
    const report = checkVersionChange({ from: v1, to: v2, entityId: "character", state, direction: "upgrade" });
    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual([expect.objectContaining({ code: "entry_invalid", entryId: SWORD, definitionId: "weapon_bonus" })]);
  });

  it("rejects the same version and other systems", () => {
    const state = characterState(v1, {});
    expect(checkVersionChange({ from: v1, to: v1, entityId: "character", state, direction: "upgrade" }).blockers[0]!.code).toBe("same_version");
    const other = { ...compile(baseDocument(), V2, "1.0.0"), systemId: "00000000-0000-4000-8000-000000000099" };
    expect(checkVersionChange({ from: v1, to: other, entityId: "character", state, direction: "upgrade" }).blockers[0]!.code).toBe("different_system");
  });

  describe("revert", () => {
    const next = baseDocument();
    next.templates = [
      sword({ fields: [
        { kind: "integer", id: "weapon_bonus", label: "Bonus", default: 2, required: true, min: 0, max: 10, step: 1 },
        sword().fields[1]!,
      ] }),
      { id: "shield", label: "Shield", kind: "item", fields: [], grantedActions: [] },
    ];
    next.entities[0]!.fields.push({ kind: "integer", id: "luck", label: "Luck", default: 5, required: false, min: 0, max: 10, step: 1 });
    const v2 = compile(next, V2, "1.1.0");

    it("returns to the previous version, keeps play values and drops new fields", () => {
      const upgraded = checkVersionChange({
        from: v1, to: v2, entityId: "character", direction: "upgrade",
        state: characterState(v1, { [SWORD]: swordEntry() }),
      });
      expect(upgraded.ok).toBe(true);
      const played = structuredClone(upgraded.nextState!);
      played.values.name = "Hero the Bold";

      const report = checkVersionChange({ from: v2, to: v1, entityId: "character", state: played, direction: "revert" });

      expect(report.blockers).toEqual([]);
      expect(report.packageFindings).toEqual([]);
      expect(report.droppedFields).toEqual(["luck"]);
      expect(report.nextState!.values.name).toBe("Hero the Bold");
      expect(report.nextState!.values).not.toHaveProperty("luck");
      expect(report.nextState!.entries![SWORD]!.values).toEqual({ weapon_bonus: 1, weight: 3 });
    });

    it("is blocked by an entry whose template only exists in the newer version", () => {
      const state = characterState(v2, {
        [SHIELD]: { entryId: SHIELD, slotId: "inventory", templateId: "shield", source: { kind: "system", templateId: "shield" }, values: {} },
      });
      const report = checkVersionChange({ from: v2, to: v1, entityId: "character", state, direction: "revert" });
      expect(report.ok).toBe(false);
      expect(report.blockers).toEqual([expect.objectContaining({ code: "entry_template_missing", entryId: SHIELD })]);
    });
  });
});
