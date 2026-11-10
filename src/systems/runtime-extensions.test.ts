import { describe, expect, it } from "vitest";

import { derivedTemplateDocument } from "./implementation/package/fixtures/campaign-derived.js";
import type { ExtensionDocumentV1, ExtensionPackageV1, SystemPackageV1 } from "./implementation/package/schema/index.js";
import { compileDocument } from "./implementation/rules/compile-document.js";
import { compileExtensionDocument } from "./implementation/rules/compile-extension.js";
import {
  createFixturePublishedExtensionLoader,
  createFixturePublishedPackageLoader,
} from "./implementation/runtime/package-loader.js";
import { createSystemRuntime, type RuntimeStateV1, type SystemRuntime } from "./runtime.js";

// System extensions, stage E3: the runtime evaluates a character against its
// base version plus extension versions (design 6.8, decision X5).

const SYSTEM_ID = "a0000000-0000-4000-8000-000000000001";
const BASE_ID = "a0000000-0000-4000-8000-000000000002";
const EXT = "e0000000-0000-4000-8000-00000000000a";
const EXT_V1 = "e1000000-0000-4000-8000-000000000001";
const EXT_V2 = "e1000000-0000-4000-8000-000000000002";
const BASE_ENTRY = "0e000000-0000-4000-8000-000000000001";
const EXT_ENTRY = "0e000000-0000-4000-8000-000000000002";
const SECRET = "0123456789abcdef0123456789abcdef";

function basePackage(): SystemPackageV1 {
  const compiled = compileDocument(derivedTemplateDocument(), { systemId: SYSTEM_ID, versionId: BASE_ID, semanticVersion: "1.0.0" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.value;
}

/** Extension whose template deliberately reuses the base template ID "sword". */
function extension(base: SystemPackageV1, versionId = EXT_V1, bonus = 5): ExtensionPackageV1 {
  const document: ExtensionDocumentV1 = {
    schemaVersion: "2.0",
    metadata: { name: "Frost pack", description: "", language: "en" },
    expressions: [
      { id: "sword_hit_expr", context: "roll", resultType: "number", source: `d20 + fields.modifier + fields.edge + ${bonus}`, fallback: 0 },
      { id: "frost_pool_expr", context: "roll", resultType: "number", source: 'countSuccesses(group("attribute", "Attribute", dice(fields.ability, 6)), 6)', fallback: 0 },
    ],
    templates: [{
      id: "sword",
      kind: "item",
      label: "Frost sword",
      fields: [{ id: "edge", kind: "integer", label: "Edge", default: 3, required: true, min: 0, max: 10, step: 1 }],
      grantedActions: [
        { id: "sword_hit", kind: "roll", label: "Frost hit", expressionId: "sword_hit_expr", inputs: [], outputTemplate: "Frost {total}" },
        {
          id: "frost_pool", kind: "roll", label: "Pool", expressionId: "frost_pool_expr", inputs: [], outputTemplate: "Pool {total}",
          pushPolicy: { version: "1.0", maxAttempts: 2, successThreshold: 99, allowOnSuccess: true, groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }] },
        },
      ],
    }],
  };
  const compiled = compileExtensionDocument(document, base, { extensionId: EXT, versionId, semanticVersion: "1.0.0" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.value.package;
}

function runtimeFor(base: SystemPackageV1, extensions: ExtensionPackageV1[]): SystemRuntime {
  return createSystemRuntime({
    loadPackage: createFixturePublishedPackageLoader([base]),
    loadExtensionPackage: createFixturePublishedExtensionLoader(extensions),
    authoritativeRollSecret: SECRET,
  });
}

async function characterState(runtime: SystemRuntime, extensions: { extensionId: string; versionId: string }[]): Promise<RuntimeStateV1> {
  const initialized = await runtime.resolve({ versionId: BASE_ID, extensions, entityId: "character", intent: { kind: "initialize" } });
  if (!initialized.ok) throw new Error(initialized.error.message);
  return {
    ...initialized.value.state,
    entries: {
      [BASE_ENTRY]: { entryId: BASE_ENTRY, slotId: "inventory", templateId: "sword", source: { kind: "system", templateId: "sword" }, values: { damage_bonus: 1, name: "Old", fuel: { current: 2, max: 3 } } },
      [EXT_ENTRY]: { entryId: EXT_ENTRY, slotId: "inventory", templateId: "sword", extensionId: EXT, source: { kind: "system", templateId: "sword", extensionId: EXT }, values: { edge: 3 } },
    },
  };
}

describe("runtime with extensions", () => {
  it("keeps same-ID base and extension templates apart on one sheet", async () => {
    const base = basePackage();
    const runtime = runtimeFor(base, [extension(base)]);
    const refs = [{ extensionId: EXT, versionId: EXT_V1 }];
    const state = await characterState(runtime, refs);
    const observed = await runtime.resolve({ versionId: BASE_ID, extensions: refs, entityId: "character", state, intent: { kind: "observe" } });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    const slot = observed.value.projection.sheets.flatMap((sheet) => sheet.sections.flatMap((section) => section.elements))
      .find((element) => element.kind === "slot");
    expect(slot?.kind === "slot" && slot.entries.map((entry) => [entry.label, entry.extensionId ?? null]))
      .toEqual([["Longsword", null], ["Frost sword", EXT]]);
    expect(observed.value.packageChecksum).toBe(base.integrity.checksum);

    const frost = await runtime.resolve({
      versionId: BASE_ID, extensions: refs, entityId: "character", state,
      intent: { kind: "action", actionId: "sword_hit", entryId: EXT_ENTRY, inputs: {}, executionId: "x1" },
    });
    expect(frost.ok).toBe(true);
    if (frost.ok) expect(frost.value.roll?.output).toMatch(/^Frost \d+$/);
    const old = await runtime.resolve({
      versionId: BASE_ID, extensions: refs, entityId: "character", state,
      intent: { kind: "action", actionId: "sword_hit", entryId: BASE_ENTRY, inputs: {}, executionId: "x2" },
    });
    expect(old.ok && old.value.roll?.output).toMatch(/^Hit \d+$/);
  });

  it("rejects extension entries without their extension and unknown compositions", async () => {
    const base = basePackage();
    const runtime = runtimeFor(base, [extension(base)]);
    const state = await characterState(runtime, [{ extensionId: EXT, versionId: EXT_V1 }]);
    const withoutExtension = await runtime.resolve({
      versionId: BASE_ID, entityId: "character", state,
      intent: { kind: "action", actionId: "sword_hit", entryId: EXT_ENTRY, inputs: {}, executionId: "x3" },
    });
    expect(withoutExtension.ok).toBe(false);
    const missing = await runtime.resolve({ versionId: BASE_ID, extensions: [{ extensionId: EXT, versionId: EXT_V2 }], entityId: "character", intent: { kind: "initialize" } });
    expect(missing.ok ? null : missing.error.code).toBe("not_found");
    const unsupported = createSystemRuntime({ loadPackage: createFixturePublishedPackageLoader([base]), authoritativeRollSecret: SECRET });
    const noLoader = await unsupported.resolve({ versionId: BASE_ID, extensions: [{ extensionId: EXT, versionId: EXT_V1 }], entityId: "character", intent: { kind: "initialize" } });
    expect(noLoader.ok ? null : noLoader.error.code).toBe("internal");
  });

  it("pushes extension rolls and treats a changed composition as changed rules", async () => {
    const base = basePackage();
    const runtime = runtimeFor(base, [extension(base), extension(base, EXT_V2, 6)]);
    const v1 = [{ extensionId: EXT, versionId: EXT_V1 }];
    const state = await characterState(runtime, v1);
    const rolled = await runtime.resolve({
      versionId: BASE_ID, extensions: v1, entityId: "character", state,
      intent: { kind: "action", actionId: "frost_pool", entryId: EXT_ENTRY, inputs: {}, executionId: "p1" },
    });
    expect(rolled.ok ? null : rolled.error).toBeNull();
    if (!rolled.ok) return;
    const context = rolled.value.pushContext!;
    expect(context).toMatchObject({ expressionId: "frost_pool_expr", extensionId: EXT, entry: { templateId: "sword", entryId: EXT_ENTRY } });
    expect(context.compositionChecksum).toMatch(/^sha256:/);

    // The Characters module stamps the durable push identity on saved rolls.
    const rollId = "0f000000-0000-4000-8000-000000000001";
    const parent = {
      ...rolled.value.roll!,
      push: { version: "1.0" as const, rollId, rootRollId: rollId, parentRollId: null, attempt: 0, maxAttempts: 2, rerolledDiceIds: [], faceOutcomes: [] },
    };
    const pushed = await runtime.resolve({
      versionId: BASE_ID, extensions: v1, entityId: "character", state,
      intent: { kind: "push", parent, context, executionId: "0f000000-0000-4000-8000-000000000002" },
    });
    expect(pushed.ok ? null : pushed.error).toBeNull();
    if (pushed.ok) expect(pushed.value.roll?.push?.attempt).toBe(1);

    const upgraded = await runtime.resolve({
      versionId: BASE_ID, extensions: [{ extensionId: EXT, versionId: EXT_V2 }], entityId: "character", state,
      intent: { kind: "push", parent, context, executionId: "0f000000-0000-4000-8000-000000000003" },
    });
    expect(upgraded.ok ? null : upgraded.error.pushReason).toBe("rules_changed");
  });

  it("describes base and extension templates with their origin", async () => {
    const base = basePackage();
    const runtime = runtimeFor(base, [extension(base)]);
    const described = await runtime.describeVersion({ versionId: BASE_ID, extensions: [{ extensionId: EXT, versionId: EXT_V1 }], includeFields: true });
    expect(described.ok && described.value.templates?.map((template) => [template.id, template.extensionId ?? null, template.label]))
      .toEqual([["sword", null, "Longsword"], ["sword", EXT, "Frost sword"]]);
  });
});
