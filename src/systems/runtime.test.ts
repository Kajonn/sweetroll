import type { Pool } from "pg";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { signSystemPackage } from "./implementation/package/canonical.js";
import {
  d20Document,
  d20Package,
  d6SuccessPoolPackage,
  pbta2d6Package,
} from "./implementation/package/fixtures/index.js";
import { validDocument } from "./implementation/package/schema/test-values.js";
import type { SystemDocumentV1, SystemPackageV1 } from "./implementation/package/schema/index.js";
import { compileDocument } from "./implementation/rules/compile-document.js";
import {
  PublishedPackageCorruptError,
  createFixturePublishedPackageLoader,
  createPostgresPublishedPackageLoader,
  type PublishedPackageLoader,
} from "./implementation/runtime/package-loader.js";
import { createSystemRuntime } from "./runtime.js";
import type {
  RuntimeErrorCode,
  RuntimeResolution,
  RuntimeResult,
  SystemRuntime,
  VersionDescription,
} from "./runtime.js";

describe("SystemRuntime contract", () => {
  it("exposes the stable asynchronous resolution contract", () => {
    expectTypeOf<SystemRuntime["resolve"]>().returns.toEqualTypeOf<
      Promise<RuntimeResult<RuntimeResolution>>
    >();
    expectTypeOf<SystemRuntime["describeVersion"]>().returns.toEqualTypeOf<
      Promise<RuntimeResult<VersionDescription>>
    >();
    expectTypeOf<RuntimeErrorCode>().toEqualTypeOf<
      | "bad_request"
      | "not_found"
      | "invalid_package"
      | "invalid_state"
      | "unsupported_field_value"
      | "budget_exceeded"
      | "internal"
    >();
  });

  it("initializes every stored field kind and observes a complete entity projection", async () => {
    const packageValue = compileRuntimePackage(allFieldDocument());
    const runtime = createRuntime(packageValue);

    const initialized = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: {
        kind: "initialize",
        values: {
          name: "Hero",
          talents: [],
          health: { current: 10, max: 10 },
        },
      },
    });

    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value.state.values).toEqual({
      name: "Hero",
      modifier: 0,
      speed: 1.5,
      ready: false,
      role: null,
      talents: [],
      health: { current: 10, max: 10 },
      portrait: null,
    });
    expect(initialized.value.state.values).not.toHaveProperty("defense");
    expect(initialized.value.derivedValues).toEqual({ defense: 10 });
    expect(initialized.value.changedDefinitionIds).toEqual([]);
    expect(initialized.value.roll).toBeNull();
    expect(initialized.value.projection).toMatchObject({
      projectionVersion: "1.0",
      systemId: packageValue.systemId,
      versionId: packageValue.versionId,
      packageChecksum: packageValue.integrity.checksum,
      entityId: "character",
      entityLabel: "Character",
      completionFields: [],
      derivedValues: { defense: 10 },
      validations: [],
    });
    expect(initialized.value.projection.sheets[0]?.sections[0]?.elements).toEqual([
      { kind: "heading", id: "stats_heading", text: "Stats", level: 2 },
      {
        kind: "field",
        id: "name_element",
        fieldId: "name",
        label: "Name",
        fieldKind: "text",
        value: "Hero",
        editable: true,
        constraints: { required: true, minLength: 1, maxLength: 120 },
        validations: [],
      },
      {
        kind: "field",
        id: "modifier_element",
        fieldId: "modifier",
        label: "Modifier",
        fieldKind: "integer",
        value: 0,
        editable: true,
        constraints: { required: true, min: -10, max: 20, step: 1 },
        validations: [],
      },
      {
        kind: "field",
        id: "speed_element",
        fieldId: "speed",
        label: "Speed",
        fieldKind: "decimal",
        value: 1.5,
        editable: true,
        constraints: { required: true, min: 0, max: 10, step: 0.5 },
        validations: [],
      },
      {
        kind: "field",
        id: "ready_element",
        fieldId: "ready",
        label: "Ready",
        fieldKind: "boolean",
        value: false,
        editable: true,
        constraints: { required: true },
        validations: [],
      },
      {
        kind: "field",
        id: "role_element",
        fieldId: "role",
        label: "Role",
        fieldKind: "singleChoice",
        value: null,
        editable: true,
        constraints: { required: false, options: [{ id: "scout", label: "Scout" }] },
        validations: [],
      },
      {
        kind: "field",
        id: "talents_element",
        fieldId: "talents",
        label: "Talents",
        fieldKind: "multiChoice",
        value: [],
        editable: true,
        constraints: { required: false, options: [{ id: "keen", label: "Keen" }] },
        validations: [],
      },
      {
        kind: "resource",
        id: "health_element",
        resourceId: "health",
        label: "Health",
        value: { current: 10, max: 10 },
        min: 0,
        max: 20,
        step: 1,
        resetTo: "max",
        validations: [],
      },
      {
        kind: "field",
        id: "defense_element",
        fieldId: "defense",
        label: "Defense",
        fieldKind: "computed",
        value: 10,
        editable: false,
        constraints: {},
        validations: [],
      },
      {
        kind: "field",
        id: "portrait_element",
        fieldId: "portrait",
        label: "Portrait",
        fieldKind: "image",
        value: null,
        editable: true,
        constraints: { required: false },
        validations: [],
      },
      {
        kind: "action",
        id: "check_element",
        actionId: "check",
        label: "Check",
        actionKind: "roll",
        inputs: [{
          id: "bonus",
          label: "Bonus",
          valueType: "integer",
          required: false,
          default: 0,
        }],
        validations: [],
      },
    ]);
    expect(JSON.stringify(initialized.value)).not.toContain('"ast"');

    const state = structuredClone(initialized.value.state);
    const before = structuredClone(state);
    const observed = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: { kind: "observe" },
    });

    expect(observed).toEqual(initialized);
    expect(state).toEqual(before);
  });

  it("keeps omitted required editable fields in completion metadata after completion", async () => {
    const document = allFieldDocument();
    document.entities[0]!.fields.push({
      kind: "text", id: "unlisted-name", label: "Unlisted name", required: true,
      default: "", minLength: 1, maxLength: 120,
    });
    const portrait = document.entities[0]!.fields.find(field => field.id === "portrait")!;
    if (portrait.kind !== "image") throw new Error("Unexpected fixture");
    portrait.required = true;
    document.sheets[0]!.sections[0]!.elements = document.sheets[0]!.sections[0]!.elements
      .filter(element => element.id !== "portrait_element" && element.id !== "defense_element");
    document.sheets.push({
      id: "second_sheet", label: "Second", targetEntityId: "character",
      sections: [{ id: "second_section", label: "Second", elements: [
        { kind: "field", id: "second_name", fieldId: "name" },
      ] }],
    });
    const packageValue = compileRuntimePackage(document);
    // The brief's hyphenated ID is injected at the loader seam; published IDs use underscores.
    const runtime = createSystemRuntime({
      loadPackage: async () => packageValue,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    const initialized = await initialize(runtime, packageValue);
    const projection = initialized.projection;
    expect(projection.projectionVersion).toBe("1.0");
    expect(projection.completionFields?.map(field => field.fieldId)).toEqual(["unlisted-name"]);
    expect(projection.completionFields?.[0]).toMatchObject({
      kind: "field", fieldKind: "text", label: "Unlisted name", value: "", editable: true,
      constraints: { required: true, minLength: 1, maxLength: 120 },
      validations: [{ targetDefinitionId: "unlisted-name" }],
    });
    expect(projection.validations).toContainEqual(expect.objectContaining({ targetDefinitionId: "portrait" }));
    const completed = await runtime.resolve({
      versionId: packageValue.versionId, entityId: "character", state: initialized.state,
      intent: { kind: "set", fieldId: "unlisted-name", value: "Hero" },
    });
    if (!completed.ok) throw new Error(completed.error.code);
    const observed = await runtime.resolve({
      versionId: packageValue.versionId, entityId: "character", state: completed.value.state,
      intent: { kind: "observe" },
    });
    if (!observed.ok) throw new Error(observed.error.code);
    expect(observed.value.projection.completionFields?.map(field => field.fieldId)).toEqual(["unlisted-name"]);
    expect(observed.value.projection.completionFields?.[0]).toMatchObject({ value: "Hero", validations: [] });
  });

  it.each([
    [d20Package, "ability", 12, { defense: 10 }],
    [pbta2d6Package, "move_stat", 2, { current_penalty: 0 }],
    [d6SuccessPoolPackage, "attribute", 3, { pool_size: 4 }],
  ])("sets an editable field and rebuilds complete output for $name", async (packageValue, fieldId, value, derivedValues) => {
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "set", fieldId, value },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.values[fieldId]).toBe(value);
    expect(result.value.derivedValues).toEqual(derivedValues);
    expect(result.value.changedDefinitionIds).toEqual([fieldId]);
    expect(result.value.roll).toBeNull();
    expect(result.value.projection.derivedValues).toEqual(derivedValues);
  });

  it("rejects computed writes and preserves null-only image storage", async () => {
    const packageValue = compileRuntimePackage(allFieldDocument());
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);

    await expect(runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "set", fieldId: "defense", value: 11 },
    })).resolves.toMatchObject({ ok: false, error: { code: "bad_request", definitionId: "defense" } });
    await expect(runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "set", fieldId: "portrait", value: "image-key" },
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_field_value",
        message: "Image field values are not supported.",
        definitionId: "portrait",
      },
    });
  });

  it.each([
    [d20Package, "health", "down" as const, 9],
    [pbta2d6Package, "harm", "up" as const, 1],
    [d6SuccessPoolPackage, "stress", "up" as const, 1],
  ])("bumps package resources by their authored step for $name", async (packageValue, resourceId, direction, current) => {
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "bump", resourceId, direction },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.values[resourceId]).toMatchObject({ current });
    expect(result.value.changedDefinitionIds).toEqual([resourceId]);
  });

  it("rejects resource bumps beyond current bounds instead of clamping", async () => {
    const runtime = createRuntime(pbta2d6Package);
    const initialized = await initialize(runtime, pbta2d6Package);

    const result = await runtime.resolve({
      versionId: pbta2d6Package.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "bump", resourceId: "harm", direction: "down" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "bad_request", definitionId: "harm" } });
  });

  it.each([
    [d20Package, "check", { bonus: 2 }, "Result: "],
    [pbta2d6Package, "make_move", { forward: 1 }, "Result: "],
    [d6SuccessPoolPackage, "test_pool", { bonus_dice: 1 }, "Successes: "],
  ])("executes deterministic roll actions without mutating state for $name", async (packageValue, actionId, inputs, outputPrefix) => {
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);
    const state = structuredClone(initialized.state);
    const before = structuredClone(state);
    const request = {
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: { kind: "action" as const, actionId, inputs, executionId: "exec-a" },
    };

    const first = await runtime.resolve(request);
    const replay = await runtime.resolve(request);

    expect(first).toEqual(replay);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state).toEqual(before);
    expect(state).toEqual(before);
    expect(first.value.changedDefinitionIds).toEqual([]);
    expect(first.value.roll).toMatchObject({ actionId, output: expect.stringMatching(`^${outputPrefix}`) });
    expect(first.value.roll?.dice.length).toBeGreaterThan(0);
  });

  it("returns normalized scoped bindings and changes dice for a different execution ID", async () => {
    const runtime = createRuntime(d6SuccessPoolPackage);
    const initialized = await initialize(runtime, d6SuccessPoolPackage);
    const execute = (executionId: string) => runtime.resolve({
      versionId: d6SuccessPoolPackage.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "action", actionId: "test_pool", inputs: { bonus_dice: 6 }, executionId },
    });

    const a = await execute("exec-a");
    const b = await execute("exec-b");

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.roll).toEqual({
      actionId: "test_pool",
      expression: "countSuccesses(dice(fields.attribute + fields.skill + inputs.bonus_dice, 6), 6)",
      dice: [4, 4, 3, 5, 3, 4, 6, 3].map((value) => ({ sides: 6, value, kept: true })),
      bindings: [
        { scope: "fields", definitionId: "attribute", value: 1 },
        { scope: "fields", definitionId: "skill", value: 1 },
        { scope: "inputs", definitionId: "bonus_dice", value: 6 },
      ],
      total: 1,
      output: "Successes: 1",
    });
    expect(a.value.roll?.dice).not.toEqual(b.value.roll?.dice);
  });

  it.each([
    ["dice count", d6SuccessPoolPackage, "test_pool", { bonus_dice: 1 }, { dicePerRoll: 2 }],
    ["sides per die", d20Package, "check", { bonus: 0 }, { sidesPerDie: 6 }],
  ])("returns budget_exceeded without a partial roll when the effective %s limit is exhausted", async (
    _limit,
    compiled,
    actionId,
    inputs,
    limit,
  ) => {
    const { integrity: _integrity, ...unsigned } = compiled;
    const packageValue = signSystemPackage({
      ...unsigned,
      effectiveLimits: { ...compiled.effectiveLimits, ...limit },
    });
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "action", actionId, inputs, executionId: "exec-limit" },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "budget_exceeded", message: "Runtime evaluation budget exceeded." },
    });
  });

  it("validates action ownership and typed inputs", async () => {
    const runtime = createRuntime(d20Package);
    const initialized = await initialize(runtime, d20Package);
    const execute = (actionId: string, inputs: Record<string, unknown>) => runtime.resolve({
      versionId: d20Package.versionId,
      entityId: "character",
      state: initialized.state,
      intent: { kind: "action", actionId, inputs, executionId: "exec-a" },
    });

    await expect(execute("check", { bonus: "two" })).resolves.toMatchObject({
      ok: false,
      error: { code: "bad_request", definitionId: "bonus" },
    });
    await expect(execute("check", { bonus: 1, extra: 2 })).resolves.toMatchObject({
      ok: false,
      error: { code: "bad_request", definitionId: "extra" },
    });
    await expect(execute("heal", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "bad_request", definitionId: "heal" },
    });
  });

  it("executes owned resource delta and reset actions without a roll", async () => {
    const document = structuredClone(d20Document);
    document.sheets[0]!.sections[2]!.elements.push(
      { kind: "action", id: "damage_element", actionId: "damage" },
      { kind: "action", id: "heal_element", actionId: "heal" },
    );
    document.actions.push({
      kind: "resourceBump",
      id: "rest",
      label: "Rest",
      resourceId: "health",
      operation: { kind: "reset" },
    });
    document.sheets[0]!.sections[2]!.elements.push({ kind: "action", id: "rest_element", actionId: "rest" });
    const packageValue = compileRuntimePackage(document);
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);
    const execute = (state: RuntimeResolution["state"], actionId: string) => runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: { kind: "action", actionId, inputs: {}, executionId: `exec-${actionId}` },
    });

    const damaged = await execute(initialized.state, "damage");
    expect(damaged.ok).toBe(true);
    if (!damaged.ok) return;
    expect(damaged.value.state.values.health).toEqual({ current: 9, max: 10 });
    expect(damaged.value.changedDefinitionIds).toEqual(["health"]);
    expect(damaged.value.roll).toBeNull();

    const reset = await execute(damaged.value.state, "rest");
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.value.state.values.health).toEqual({ current: 10, max: 10 });
    expect(reset.value.changedDefinitionIds).toEqual(["health"]);
    expect(reset.value.roll).toBeNull();
  });

  it.each([
    ["unknown IDs", { extra: true }],
    ["computed values", { defense: 10 }],
    ["non-finite numbers", { modifier: Number.POSITIVE_INFINITY }],
    ["off-step numbers", { speed: 1.25 }],
    ["invalid option IDs", { role: "mage" }],
    ["duplicate multi-choice IDs", { talents: ["keen", "keen"] }],
    ["resource current above max", { health: { current: 7, max: 6 } }],
  ])("rejects %s in stored state", async (_name, replacement) => {
    const packageValue = compileRuntimePackage(validDocument());
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);
    const state = structuredClone(initialized.state);
    Object.assign(state.values, replacement);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state,
      intent: { kind: "observe" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("rejects unknown runtime-state envelope properties", async () => {
    const packageValue = compileRuntimePackage(validDocument());
    const runtime = createRuntime(packageValue);
    const initialized = await initialize(runtime, packageValue);

    const result = await runtime.resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      state: { ...initialized.state, extra: true } as never,
      intent: { kind: "observe" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("rejects non-null image initialization without inventing image storage", async () => {
    const packageValue = compileRuntimePackage(validDocument());
    const result = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize", values: { portrait: "https://example.test/hero.png" } },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_field_value",
        message: "Image field values are not supported.",
        definitionId: "portrait",
      },
    });
  });

  it("returns authored validations, including when arithmetic uses its fallback", async () => {
    const document = validDocument();
    document.expressions.find((expression) => expression.id === "health_valid_expr")!.source =
      "fields.health / fields.modifier > 0";
    const packageValue = compileRuntimePackage(document);

    const resolution = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize", values: { name: "Hero" } },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.validations).toEqual([
      {
        validationId: "health_valid",
        severity: "error",
        message: "Health must be non-negative",
        targetDefinitionId: "health",
      },
      {
        validationId: "health_warning",
        severity: "warning",
        message: "Health is low",
        targetDefinitionId: "health",
      },
    ]);
    expect(resolution.value.projection.sheets[0]?.sections[0]?.elements[2]).toMatchObject({
      kind: "resource",
      validations: resolution.value.validations,
    });
  });

  it("reports missing required text, choice, and image values without rejecting state", async () => {
    const document = validDocument();
    const entity = document.entities[0]!;
    const role = entity.fields.find((field) => field.id === "role")!;
    const talents = entity.fields.find((field) => field.id === "talents")!;
    const portrait = entity.fields.find((field) => field.id === "portrait")!;
    if (role.kind !== "singleChoice" || talents.kind !== "multiChoice" || portrait.kind !== "image") {
      throw new Error("Unexpected fixture fields");
    }
    role.required = true;
    talents.required = true;
    talents.default = [];
    portrait.required = true;

    const packageValue = compileRuntimePackage(document);
    const resolution = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize" },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.validations).toEqual([
      {
        validationId: "required_name",
        severity: "error",
        message: "Name is required.",
        targetDefinitionId: "name",
      },
      {
        validationId: "required_role",
        severity: "error",
        message: "Role is required.",
        targetDefinitionId: "role",
      },
      {
        validationId: "required_talents",
        severity: "error",
        message: "Talents is required.",
        targetDefinitionId: "talents",
      },
      {
        validationId: "required_portrait",
        severity: "error",
        message: "Portrait is required.",
        targetDefinitionId: "portrait",
      },
    ]);
    expect(resolution.value.state.values).toMatchObject({
      name: "",
      role: null,
      talents: [],
      portrait: null,
    });
  });

  it("evaluates validations targeting actions owned by the requested entity", async () => {
    const document = validDocument();
    document.validations = [document.validations[0]!];
    document.validations[0]!.targetId = "check";
    document.expressions.find((expression) => expression.id === "health_valid_expr")!.source =
      "fields.modifier > 0";
    const packageValue = compileRuntimePackage(document);

    const resolution = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize", values: { name: "Hero" } },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.validations).toEqual([{
      validationId: "health_valid",
      severity: "error",
      message: "Health must be non-negative",
      targetDefinitionId: "check",
    }]);
    expect(resolution.value.projection.sheets[0]?.sections[0]?.elements[3]).toMatchObject({
      kind: "action",
      actionId: "check",
      validations: resolution.value.validations,
    });
  });

  it("reports computed arithmetic diagnostics while preserving the authored fallback", async () => {
    const document = validDocument();
    document.expressions.find((expression) => expression.id === "defense_expr")!.source =
      "fields.modifier / 0";
    const packageValue = compileRuntimePackage(document);

    const resolution = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize", values: { name: "Hero" } },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.derivedValues.defense).toBe(10);
    expect(resolution.value.validations).toContainEqual({
      validationId: "arithmetic_defense_expr",
      severity: "error",
      message: "division by zero",
      targetDefinitionId: "defense",
    });
  });

  it("returns budget_exceeded without a partial resolution", async () => {
    const compiled = compileRuntimePackage(validDocument());
    const { integrity: _integrity, ...unsigned } = compiled;
    const packageValue = signSystemPackage({
      ...unsigned,
      effectiveLimits: { ...compiled.effectiveLimits, expressionAstNodes: 1 },
    });

    const result = await createRuntime(packageValue).resolve({
      versionId: packageValue.versionId,
      entityId: "character",
      intent: { kind: "initialize", values: { name: "Hero" } },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "budget_exceeded", message: "Runtime evaluation budget exceeded." },
    });
  });

  it("maps missing and corrupt packages and validates the authoritative secret", async () => {
    expect(() => createSystemRuntime({
      loadPackage: async () => null,
      authoritativeRollSecret: "short",
    })).toThrow("Authoritative roll secret must be at least 32 UTF-8 bytes.");

    const missing = createSystemRuntime({
      loadPackage: async () => null,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    await expect(missing.resolve({
      versionId: "00000000-0000-4000-8000-000000000099",
      entityId: "character",
      intent: { kind: "initialize" },
    })).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });

    const corrupt = createSystemRuntime({
      loadPackage: async () => {
        throw new PublishedPackageCorruptError("00000000-0000-4000-8000-000000000099");
      },
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    await expect(corrupt.resolve({
      versionId: "00000000-0000-4000-8000-000000000099",
      entityId: "character",
      intent: { kind: "initialize" },
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_package" } });
  });
});

describe("SystemRuntime.describeVersion", () => {
  it("describes the reference entity IDs and labels for every reference system", async () => {
    for (const packageValue of [d20Package, d6SuccessPoolPackage, pbta2d6Package]) {
      const runtime = createRuntime(packageValue);
      const described = await runtime.describeVersion({ versionId: packageValue.versionId });

      expect(described.ok).toBe(true);
      if (!described.ok) return;
      expect(described.value).toEqual({
        versionId: packageValue.versionId,
        packageChecksum: packageValue.integrity.checksum,
        entities: [{ id: "character", label: "Character" }],
      });
    }
  });

  it("shares the package loading and corruption checks with resolve", async () => {
    const runtime = createSystemRuntime({
      loadPackage: async () => d20Package,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    const mismatched = await runtime.describeVersion({ versionId: "00000000-0000-4000-8000-000000000099" });
    expect(mismatched).toMatchObject({ ok: false, error: { code: "invalid_package" } });

    const missing = createSystemRuntime({
      loadPackage: async () => null,
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    await expect(missing.describeVersion({ versionId: "00000000-0000-4000-8000-000000000099" })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    const corrupt = createSystemRuntime({
      loadPackage: async () => {
        throw new PublishedPackageCorruptError("00000000-0000-4000-8000-000000000099");
      },
      authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
    });
    await expect(
      corrupt.describeVersion({ versionId: "00000000-0000-4000-8000-000000000099" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_package" } });
  });
});

describe("published package loaders", () => {
  it("loads fixture packages by exact version and returns null for absence", async () => {
    const loadPackage = createFixturePublishedPackageLoader([d20Package]);

    expect(await loadPackage(d20Package.versionId)).toEqual(d20Package);
    expect(await loadPackage("missing")).toBeNull();
  });

  it("decodes a package loaded from PostgreSQL", async () => {
    const pool = queryPool([{ package_json: d20Package, checksum: d20Package.integrity.checksum }]);
    const loadPackage = createPostgresPublishedPackageLoader(pool);

    const loaded = await loadPackage(d20Package.versionId);

    expectTypeOf(loadPackage).toEqualTypeOf<PublishedPackageLoader>();
    expect(loaded).toEqual(d20Package);
  });

  it("returns null when PostgreSQL has no matching version", async () => {
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([]));

    expect(await loadPackage("missing")).toBeNull();
  });

  it("throws typed corruption without package JSON for a malformed row", async () => {
    const malformedPackage = { versionId: d20Package.versionId, privateValue: "do-not-leak" };
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([
      { package_json: malformedPackage, checksum: d20Package.integrity.checksum },
    ]));

    const error = await captureCorruption(loadPackage, d20Package.versionId);

    expect(error).toMatchObject({
      code: "published_package_corrupt",
      versionId: d20Package.versionId,
    });
    expect(JSON.stringify(error)).not.toContain("do-not-leak");
  });

  it("throws typed corruption when the row checksum differs from the package", async () => {
    const rowChecksum = `sha256:${"0".repeat(64)}`;
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([
      { package_json: d20Package, checksum: rowChecksum },
    ]));

    const error = await captureCorruption(loadPackage, d20Package.versionId);

    expect(error).toMatchObject({
      code: "published_package_corrupt",
      versionId: d20Package.versionId,
    });
    expect(JSON.stringify(error)).not.toContain(JSON.stringify(d20Package));
  });
});

function queryPool(rows: Array<{ package_json: unknown; checksum: string }>): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

async function captureCorruption(
  loadPackage: (versionId: string) => Promise<SystemPackageV1 | null>,
  versionId: string,
): Promise<PublishedPackageCorruptError> {
  try {
    await loadPackage(versionId);
  } catch (error) {
    expect(error).toBeInstanceOf(PublishedPackageCorruptError);
    return error as PublishedPackageCorruptError;
  }
  throw new Error("Expected published package corruption");
}

function compileRuntimePackage(document: SystemDocumentV1): SystemPackageV1 {
  document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
  const result = compileDocument(document, {
    systemId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    semanticVersion: "1.0.0",
  });
  if (!result.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}

function createRuntime(packageValue: SystemPackageV1): SystemRuntime {
  return createSystemRuntime({
    loadPackage: createFixturePublishedPackageLoader([packageValue]),
    authoritativeRollSecret: "0123456789abcdef0123456789abcdef",
  });
}

async function initialize(
  runtime: SystemRuntime,
  packageValue: SystemPackageV1,
): Promise<RuntimeResolution> {
  const hasName = packageValue.entities
    .find((entity) => entity.id === "character")
    ?.fields.some((field) => field.id === "name");
  const result = await runtime.resolve({
    versionId: packageValue.versionId,
    entityId: "character",
    intent: { kind: "initialize", ...(hasName ? { values: { name: "Hero" } } : {}) },
  });
  if (!result.ok) throw new Error(`Initialization failed: ${result.error.code}`);
  return result.value;
}

function allFieldDocument(): SystemDocumentV1 {
  const document = validDocument();
  document.sheets[0]!.sections[0]!.elements = [
    { kind: "heading", id: "stats_heading", text: "Stats", level: 2 },
    { kind: "field", id: "name_element", fieldId: "name" },
    { kind: "field", id: "modifier_element", fieldId: "modifier" },
    { kind: "field", id: "speed_element", fieldId: "speed" },
    { kind: "field", id: "ready_element", fieldId: "ready" },
    { kind: "field", id: "role_element", fieldId: "role" },
    { kind: "field", id: "talents_element", fieldId: "talents" },
    { kind: "resource", id: "health_element", resourceId: "health" },
    { kind: "field", id: "defense_element", fieldId: "defense" },
    { kind: "field", id: "portrait_element", fieldId: "portrait" },
    { kind: "action", id: "check_element", actionId: "check" },
  ];
  return document;
}
