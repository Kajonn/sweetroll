import type { Pool } from "pg";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { signSystemPackage } from "./implementation/package/canonical.js";
import { d20Package } from "./implementation/package/fixtures/index.js";
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
} from "./runtime.js";

describe("SystemRuntime contract", () => {
  it("exposes the stable asynchronous resolution contract", () => {
    expectTypeOf<SystemRuntime["resolve"]>().returns.toEqualTypeOf<
      Promise<RuntimeResult<RuntimeResolution>>
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
      authoritativeRollSecret: "",
    })).toThrow("Authoritative roll secret must not be empty.");

    const missing = createSystemRuntime({
      loadPackage: async () => null,
      authoritativeRollSecret: "runtime-test-secret",
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
      authoritativeRollSecret: "runtime-test-secret",
    });
    await expect(corrupt.resolve({
      versionId: "00000000-0000-4000-8000-000000000099",
      entityId: "character",
      intent: { kind: "initialize" },
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid_package" } });
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
    authoritativeRollSecret: "runtime-test-secret",
  });
}

async function initialize(
  runtime: SystemRuntime,
  packageValue: SystemPackageV1,
): Promise<RuntimeResolution> {
  const result = await runtime.resolve({
    versionId: packageValue.versionId,
    entityId: "character",
    intent: { kind: "initialize", values: { name: "Hero" } },
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
