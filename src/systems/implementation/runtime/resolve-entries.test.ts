import { describe, expect, it } from "vitest";

import { compileDocument } from "../rules/compile-document.js";
import { validDocument } from "../package/schema/test-values.js";
import type { SystemDocumentV1, SystemPackageV1 } from "../package/schema/index.js";
import { createFixturePublishedPackageLoader } from "./package-loader.js";
import { createSystemRuntime, type SystemRuntime } from "../../runtime.js";

const SWORD_ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const TORCH_ENTRY_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const STONE_ENTRY_ID = "00000000-0000-4000-8000-000000000000";

function entryDocument(): SystemDocumentV1 {
  const document = validDocument();
  document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
  document.entities[0]!.fields.push({
    kind: "integer",
    id: "strength_mod",
    label: "Strength",
    default: 2,
    required: true,
    min: -10,
    max: 20,
    step: 1,
  });
  document.templates = [
    {
      id: "longsword",
      label: "Longsword",
      kind: "item",
      fields: [{
        kind: "integer",
        id: "weapon_bonus",
        label: "Bonus",
        default: 1,
        required: true,
        min: 0,
        max: 10,
        step: 1,
      }],
      grantedActions: [{
        kind: "roll",
        id: "longsword_attack",
        label: "Longsword Attack",
        expressionId: "longsword_attack_expr",
        inputs: [{
          id: "edge",
          label: "Edge",
          valueType: "integer",
          required: false,
          default: 0,
        }],
        outputTemplate: "Longsword: {total}",
      }],
    },
    {
      id: "torch",
      label: "Torch",
      kind: "item",
      fields: [{
        kind: "resource",
        id: "fuel",
        label: "Fuel",
        default: { current: 3, max: 3 },
        min: 0,
        max: 3,
        step: 1,
        resetTo: "max",
      }],
      grantedActions: [
        {
          kind: "roll",
          id: "raise_torch",
          label: "Raise Torch",
          expressionId: "torch_shine_expr",
          inputs: [],
          outputTemplate: "You raise your torch.",
          nominal: true,
        },
        {
          kind: "resourceBump",
          id: "stoke",
          label: "Stoke",
          resourceId: "fuel",
          operation: { kind: "delta", amount: 1 },
        },
      ],
    },
  ];
  document.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
  document.expressions.push(
    {
      id: "longsword_attack_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.weapon_bonus + inputs.edge",
      fallback: 0,
    },
    {
      id: "torch_shine_expr",
      context: "roll",
      resultType: "number",
      source: "d20",
      fallback: 0,
    },
  );
  return document;
}

// The Task 2 global duplicate-id rule forbids a template field that shares an
// entity field id, so the brief's literal `d20 + fields.strength_mod +
// fields.bonus` case (character strength_mod + entry bonus) cannot pass the
// strict decode path. These two tests drive runtime.resolve with a compiled
// package that collides on purpose, loaded raw (no structural validation), to
// pin the entry-first merge order at the resolution layer.
function collisionDocument(): SystemDocumentV1 {
  const document = entryDocument();
  document.templates![0]!.fields.push({
    kind: "integer",
    id: "strength_mod",
    label: "Strength",
    default: 0,
    required: true,
    min: -10,
    max: 20,
    step: 1,
  });
  document.expressions.find((expression) => expression.id === "longsword_attack_expr")!.source =
    "d20 + fields.strength_mod + fields.weapon_bonus";
  return document;
}

function compileEntryPackage(document: SystemDocumentV1): SystemPackageV1 {
  const result = compileDocument(document, {
    systemId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    semanticVersion: "1.0.0",
  });
  if (!result.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}

function createRuntime(packageValue: SystemPackageV1, strict = true): SystemRuntime {
  return createSystemRuntime({
    loadPackage: strict
      ? createFixturePublishedPackageLoader([packageValue])
      : async (versionId) => (versionId === packageValue.versionId ? packageValue : null),
    authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
  });
}

async function initializedState(runtime: SystemRuntime, packageValue: SystemPackageV1) {
  const initialized = await runtime.resolve({
    versionId: packageValue.versionId,
    entityId: "character",
    intent: { kind: "initialize", values: { name: "Hero" } },
  });
  if (!initialized.ok) throw new Error(`Initialization failed: ${initialized.error.code}`);
  expect(initialized.value.state.values.strength_mod).toBe(2);
  return initialized.value.state;
}

describe("granted-action resolution", () => {
  it("rolls Longsword to hit and then damage using the character's Strength", async () => {
    const document = entryDocument();
    document.sheets[0]!.sections[0]!.elements.push({ kind: "slot", id: "inventory_element", slotId: "inventory" });
    document.expressions.find((expression) => expression.id === "longsword_attack_expr")!.source =
      "d20 + fields.strength_mod + fields.weapon_bonus";
    document.templates![0]!.grantedActions.push({
      kind: "roll", id: "longsword_damage", label: "Longsword Damage",
      expressionId: "longsword_damage_expr", inputs: [], outputTemplate: "Damage: {total}",
    });
    document.expressions.push({
      id: "longsword_damage_expr", context: "roll", resultType: "number",
      source: "d8 + fields.strength_mod", fallback: 0,
    });
    const pkg = compileEntryPackage(document);
    const runtime = createRuntime(pkg);
    const state = await initializedState(runtime, pkg);
    state.values.strength_mod = 3;
    state.entries = { ...state.entries, [SWORD_ENTRY_ID]: {
      entryId: SWORD_ENTRY_ID, slotId: "inventory", templateId: "longsword", values: { weapon_bonus: 1 },
    } };
    for (const [actionId, sides, offset] of [["longsword_attack", 20, 4], ["longsword_damage", 8, 3]] as const) {
      const result = await runtime.resolve({
        versionId: pkg.versionId, entityId: "character", state,
        intent: { kind: "action", actionId, entryId: SWORD_ENTRY_ID, inputs: {}, executionId: `exec-${actionId}` },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.roll?.dice[0]?.sides).toBe(sides);
      expect(result.value.roll?.total).toBe((result.value.roll?.dice[0]?.value ?? 0) + offset);
      expect(result.value.roll?.bindings).toContainEqual({ scope: "fields", definitionId: "strength_mod", value: 3 });
      expect(result.value.state).toEqual(state);
    }
  });

  it("evaluates a granted roll with the entry value in scope", async () => {
    const packageValue = compileEntryPackage(entryDocument());
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [SWORD_ENTRY_ID]: {
          entryId: SWORD_ENTRY_ID,
          slotId: "inventory",
          templateId: "longsword",
          values: { weapon_bonus: 1 },
        },
      },
    };
    const before = structuredClone(state);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "longsword_attack",
        inputs: { edge: 0 },
        executionId: "exec-granted-1",
        entryId: SWORD_ENTRY_ID,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roll).toMatchObject({ actionId: "longsword_attack" });
    expect(result.value.roll?.bindings).toEqual(expect.arrayContaining([
      { scope: "fields", definitionId: "weapon_bonus", value: 1 },
      { scope: "inputs", definitionId: "edge", value: 0 },
    ]));
    expect(result.value.roll?.output).toMatch(/^Longsword: /);
    expect(result.value.roll?.dice.length).toBeGreaterThan(0);
    expect(result.value.nominal).toBeNull();
    expect(result.value.state).toEqual(before);
    expect(result.value.changedDefinitionIds).toEqual([]);
  });

  it("lets the character stat show through when the entry omits it", async () => {
    const packageValue = compileEntryPackage(collisionDocument());
    const runtime = createRuntime(packageValue, false);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [SWORD_ENTRY_ID]: {
          entryId: SWORD_ENTRY_ID,
          slotId: "inventory",
          templateId: "longsword",
          values: { weapon_bonus: 1 },
        },
      },
    };

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "longsword_attack",
        inputs: {},
        executionId: "exec-granted-2",
        entryId: SWORD_ENTRY_ID,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roll?.bindings).toEqual(expect.arrayContaining([
      { scope: "fields", definitionId: "strength_mod", value: 2 },
      { scope: "fields", definitionId: "weapon_bonus", value: 1 },
    ]));
  });

  it("lets an entry value shadow the same-named character field", async () => {
    const packageValue = compileEntryPackage(collisionDocument());
    const runtime = createRuntime(packageValue, false);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [SWORD_ENTRY_ID]: {
          entryId: SWORD_ENTRY_ID,
          slotId: "inventory",
          templateId: "longsword",
          values: { weapon_bonus: 1, strength_mod: 5 },
        },
      },
    };

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "longsword_attack",
        inputs: {},
        executionId: "exec-granted-3",
        entryId: SWORD_ENTRY_ID,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roll?.bindings).toEqual(expect.arrayContaining([
      { scope: "fields", definitionId: "strength_mod", value: 5 },
      { scope: "fields", definitionId: "weapon_bonus", value: 1 },
    ]));
  });

  it("returns a nominal result with display text and no state change", async () => {
    const packageValue = compileEntryPackage(entryDocument());
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [TORCH_ENTRY_ID]: {
          entryId: TORCH_ENTRY_ID,
          slotId: "inventory",
          templateId: "torch",
          values: { fuel: { current: 3, max: 3 } },
        },
      },
    };
    const before = structuredClone(state);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "raise_torch",
        inputs: {},
        executionId: "exec-nominal-1",
        entryId: TORCH_ENTRY_ID,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roll).toBeNull();
    expect(result.value.nominal).toEqual({
      actionId: "raise_torch",
      entryId: TORCH_ENTRY_ID,
      output: "You raise your torch.",
    });
    expect(result.value.state).toEqual(before);
    expect(result.value.changedDefinitionIds).toEqual([]);
  });

  it("mutates the entry resource for a granted bump", async () => {
    const packageValue = compileEntryPackage(entryDocument());
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [TORCH_ENTRY_ID]: {
          entryId: TORCH_ENTRY_ID,
          slotId: "inventory",
          templateId: "torch",
          values: { fuel: { current: 1, max: 3 } },
        },
      },
    };

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "stoke",
        inputs: {},
        executionId: "exec-bump-1",
        entryId: TORCH_ENTRY_ID,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.entries?.[TORCH_ENTRY_ID]?.values).toEqual({
      fuel: { current: 2, max: 3 },
    });
    expect(result.value.changedDefinitionIds).toEqual(["fuel"]);
    expect(result.value.roll).toBeNull();
    expect(result.value.nominal).toBeNull();
  });

  it("rejects a granted-action attempt on a custom entry", async () => {
    const packageValue = compileEntryPackage(entryDocument());
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [STONE_ENTRY_ID]: {
          entryId: STONE_ENTRY_ID,
          slotId: "inventory",
          templateId: null,
          values: { name: "Lucky Stone" },
        },
      },
    };

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        actionId: "longsword_attack",
        inputs: {},
        executionId: "exec-custom-1",
        entryId: STONE_ENTRY_ID,
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  it("rejects a granted-action attempt for an unknown entryId", async () => {
    const packageValue = compileEntryPackage(entryDocument());
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: base,
      intent: {
        kind: "action",
        actionId: "longsword_attack",
        inputs: {},
        executionId: "exec-unknown-1",
        entryId: "99999999-9999-4999-8999-999999999999",
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("slot projection", () => {
  it("projects slot elements with entries and synthetic granted actions", async () => {
    const document = entryDocument();
    (document.sheets[0]!.sections[0]!.elements as unknown[]).push({
      kind: "slot",
      id: "inv_element",
      slotId: "inventory",
    });
    const packageValue = compileEntryPackage(document);
    const runtime = createRuntime(packageValue);
    const base = await initializedState(runtime, packageValue);
    const state = {
      ...structuredClone(base),
      entries: {
        [SWORD_ENTRY_ID]: {
          entryId: SWORD_ENTRY_ID,
          slotId: "inventory",
          templateId: "longsword",
          values: { weapon_bonus: 1 },
        },
        [STONE_ENTRY_ID]: {
          entryId: STONE_ENTRY_ID,
          slotId: "inventory",
          templateId: null,
          values: { name: "Lucky Stone" },
        },
      },
    };

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: { kind: "observe" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projection.projectionVersion).toBe("1.0");
    const elements = result.value.projection.sheets[0]!.sections[0]!.elements;
    const slotIndex = elements.findIndex((element) => element.kind === "slot");
    expect(slotIndex).toBeGreaterThanOrEqual(0);
    expect(elements[slotIndex]).toEqual({
      kind: "slot",
      id: "inv_element",
      slotId: "inventory",
      label: "Inventory",
      accepts: ["item"],
      entries: [
        {
          entryId: STONE_ENTRY_ID,
          templateId: null,
          label: "Lucky Stone",
          values: { name: "Lucky Stone" },
        },
        {
          entryId: SWORD_ENTRY_ID,
          templateId: "longsword",
          label: "Longsword",
          values: { weapon_bonus: 1 },
        },
      ],
    });
    expect(elements[slotIndex + 1]).toMatchObject({
      kind: "action",
      actionId: "longsword_attack",
      entryId: SWORD_ENTRY_ID,
      label: "Longsword Attack",
      actionKind: "roll",
      inputs: [{
        id: "edge",
        label: "Edge",
        valueType: "integer",
        required: false,
        default: 0,
      }],
      validations: [],
    });
    const trailing = elements.slice(slotIndex + 1);
    expect(trailing.filter((element) => element.kind === "action")).toHaveLength(1);
  });
});
