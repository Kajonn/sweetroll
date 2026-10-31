import { Value } from "@sinclair/typebox/value";
import { PushContextSchema } from "../../src/systems/implementation/runtime/push-context.js";
import { describe, expect, it } from "vitest";
import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { decodeSystemPackage } from "../../src/systems/implementation/package/codec.js";
import { createSystemRuntime } from "../../src/systems/runtime.js";
import { createFixturePublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import {
  materializeDefaults,
  templateApplicable,
} from "../../src/systems/implementation/runtime/effective-entry.js";
import type { CharacterEntryV1 } from "../../src/systems/implementation/package/schema/index.js";
const first = "aaaaaaaa-1111-4111-8111-111111111111",
  second = "bbbbbbbb-2222-4222-8222-222222222222";
function fixture() {
  const compiled = compileDocument(derivedTemplateDocument(), {
    systemId: first,
    versionId: second,
    semanticVersion: "1.0.0",
  });
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  if (!compiled.ok) throw Error("fixture compile");
  expect(decodeSystemPackage(compiled.value).ok).toBe(true);
  return compiled.value;
}
describe("derived fixture and runtime parity", () => {
  it("publishes the exact integration/browser fixture through the strict package contract", () => {
    const pkg = fixture();
    expect(pkg.templates![0]!.grantedActions).toHaveLength(5);
    expect(
      templateApplicable(
        pkg,
        pkg.entities.find((e) => e.id === "npc")!,
        pkg.templates![0]!,
      ),
    ).toBe(false);
  });
  it("keeps metadata, typed fields, nominal/resource effects and independent copies consistent", async () => {
    const pkg = fixture(),
      runtime = createSystemRuntime({
        loadPackage: createFixturePublishedPackageLoader([pkg]),
        authoritativeRollSecret: "test-derived-secret-32-characters",
      });
    const initialized = await runtime.resolve({
      versionId: pkg.versionId,
      entityId: "character",
      intent: { kind: "initialize" },
    });
    if (!initialized.ok) throw Error(JSON.stringify(initialized.error));
    const state = initialized.value.state,
      base = pkg.templates![0]!;
    const copy = (entryId: string): CharacterEntryV1 => ({
      entryId,
      slotId: "inventory",
      templateId: null,
      source: {
        kind: "campaign",
        campaignId: first,
        templateId: second,
        templateRevision: 1,
        contentRevision: 1,
      },
      snapshot: {
        kind: "item",
        values: { name: "Captain's sword" },
        base: {
          versionId: pkg.versionId,
          packageChecksum: pkg.integrity.checksum,
          templateId: base.id,
        },
        defaultValues: materializeDefaults(base, { damage_bonus: 4 }),
      },
      values: materializeDefaults(base, { damage_bonus: 4 }),
    });
    state.entries = { [first]: copy(first), [second]: copy(second) };
    async function action(actionId: string) {
      return runtime.resolve({
        versionId: pkg.versionId,
        entityId: "character",
        state,
        intent: {
          kind: "action",
          entryId: first,
          actionId,
          inputs: {},
          executionId: first,
        },
      });
    }
    const observed = await runtime.resolve({
      versionId: pkg.versionId,
      entityId: "character",
      state,
      intent: { kind: "observe" },
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(
      observed.value.projection.sheets[0]!.sections[0]!.elements.find(
        (e) => e.kind === "slot",
      ),
    ).toMatchObject({
      entries: [
        { label: "Captain's sword", values: { name: "Binding name" } },
        { label: "Captain's sword", values: { name: "Binding name" } },
      ],
    });
    for (const id of ["sword_hit", "sword_damage"]) {
      const rolled = await action(id);
      expect(rolled.ok).toBe(true);
      if (rolled.ok)
        expect(rolled.value.roll?.bindings).toContainEqual({
          scope: "fields",
          definitionId: "damage_bonus",
          value: 4,
        });
    }
    const nominal = await action("sword_salute");
    expect(nominal).toMatchObject({
      ok: true,
      value: { roll: null, nominal: { output: "You salute" } },
    });
    const bump = await action("sword_refuel");
    expect(bump.ok).toBe(true);
    if (bump.ok) {
      expect(bump.value.state.entries![first]!.values.fuel).toEqual({
        current: 3,
        max: 3,
      });
      expect(bump.value.state.entries![second]!.values.fuel).toEqual({
        current: 2,
        max: 3,
      });
    }
    state.entries[first]!.values.unknown = 1;
    expect((await action("sword_hit")).ok).toBe(false);
  });
  it("saves derived push provenance, preserves original bindings and denies source removal/replacement", async () => {
    const pkg = fixture(),
      runtime = createSystemRuntime({
        loadPackage: createFixturePublishedPackageLoader([pkg]),
        authoritativeRollSecret: "test-derived-secret-32-characters",
      });
    const initialized = await runtime.resolve({
      versionId: pkg.versionId,
      entityId: "character",
      intent: { kind: "initialize" },
    });
    if (!initialized.ok) throw Error("init");
    const state = initialized.value.state,
      base = pkg.templates![0]!;
    const entry: CharacterEntryV1 = {
      entryId: first,
      slotId: "inventory",
      templateId: null,
      source: {
        kind: "campaign",
        campaignId: first,
        templateId: second,
        templateRevision: 1,
        contentRevision: 1,
      },
      snapshot: {
        kind: "item",
        values: { name: "Sword" },
        base: {
          versionId: pkg.versionId,
          packageChecksum: pkg.integrity.checksum,
          templateId: "sword",
        },
        defaultValues: materializeDefaults(base),
      },
      values: materializeDefaults(base),
    };
    state.entries = { [first]: entry };
    const result = await runtime.resolve({
      versionId: pkg.versionId,
      entityId: "character",
      state,
      intent: {
        kind: "action",
        entryId: first,
        actionId: "sword_pool",
        inputs: {},
        executionId: first,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.roll || !result.value.pushContext) return;
    expect(Value.Check(PushContextSchema, result.value.pushContext)).toBe(true);
    const parent = {
        ...result.value.roll,
        push: {
          version: "1.0" as const,
          rollId: first,
          rootRollId: first,
          parentRollId: null,
          attempt: 0,
          maxAttempts: 2,
          rerolledDiceIds: [],
          faceOutcomes: [],
        },
      },
      context = result.value.pushContext;
    expect(context.entry).toMatchObject({
      templateId: "sword",
      entryId: first,
      source: entry.source,
    });
    state.values.ability = 3;
    state.entries[first]!.values.damage_bonus = 7;
    const push = () =>
      runtime.resolve({
        versionId: pkg.versionId,
        entityId: "character",
        state,
        intent: { kind: "push", parent, context, executionId: second },
      });
    const pushed = await push();
    expect(pushed.ok).toBe(true);
    if (pushed.ok) expect(pushed.value.roll?.bindings).toEqual(parent.bindings);
    delete state.entries[first];
    expect(await push()).toMatchObject({
      ok: false,
      error: { pushReason: "source_unavailable" },
    });
    state.entries[first] = entry;
    expect((await push()).ok).toBe(true);
    if (entry.source?.kind === "campaign") entry.source.contentRevision = 2;
    expect(await push()).toMatchObject({
      ok: false,
      error: { pushReason: "source_unavailable" },
    });
  });
});
