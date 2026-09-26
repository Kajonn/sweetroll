import { describe, expect, it } from "vitest";

import { comparePackages } from "./compatibility.js";
import { PACKAGE_LIMITS } from "./limits.js";
import { validDocument, validSignedPackage } from "./schema/test-values.js";
import type { SystemPackageV1 } from "./schema/package.js";
import { validateDocumentStructure } from "./structural.js";

function rollAction(id: string, expressionId = "check_expr") {
  return {
    kind: "roll",
    id,
    label: "Attack",
    expressionId,
    inputs: [],
    outputTemplate: "Result: {total}",
  };
}

function itemTemplate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: "Item",
    kind: "item",
    fields: [],
    grantedActions: [rollAction(`${id}_attack`)],
    ...overrides,
  };
}

function documentWith(templates: unknown[], slots: unknown[] = []) {
  const doc = validDocument() as unknown as Record<string, unknown>;
  doc.templates = templates;
  doc.slots = slots;
  return doc as Parameters<typeof validateDocumentStructure>[0];
}

function packageWith(templates: unknown[], slots: unknown[] = []) {
  const pkg = validSignedPackage() as unknown as Record<string, unknown>;
  pkg.templates = templates;
  pkg.slots = slots;
  return pkg as SystemPackageV1;
}

describe("template/slot structural validation", () => {
  it("accepts legacy documents without templates/slots arrays", () => {
    expect(validateDocumentStructure(validDocument())).toEqual([]);
  });

  it("accepts a valid template, slot, and slot element", () => {
    const doc = validDocument() as unknown as Record<string, unknown>;
    doc.templates = [
      {
        id: "torch",
        label: "Torch",
        kind: "item",
        fields: [
          {
            kind: "resource",
            id: "fuel",
            label: "Fuel",
            default: { current: 3, max: 3 },
            min: 0,
            max: 3,
            step: 1,
            resetTo: "max",
          },
        ],
        grantedActions: [
          rollAction("torch_attack"),
          {
            kind: "resourceBump",
            id: "torch_refuel",
            label: "Refuel",
            resourceId: "fuel",
            operation: { kind: "delta", amount: 1 },
          },
        ],
      },
    ];
    doc.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
    const sheets = doc.sheets as Record<string, unknown>[];
    const sections = (sheets[0] as Record<string, unknown>).sections as Record<string, unknown>[];
    (sections[0] as { elements: unknown[] }).elements.push({
      kind: "slot",
      id: "inv_element",
      slotId: "inventory",
    });
    expect(validateDocumentStructure(doc as never)).toEqual([]);
  });

  it("flags a duplicate template id", () => {
    const diagnostics = validateDocumentStructure(
      documentWith([itemTemplate("torch"), itemTemplate("torch", { grantedActions: [rollAction("torch_attack_2")] })]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_definition_id", path: "/templates/1/id" }),
    );
  });

  it("flags a template field id colliding with the global set", () => {
    const diagnostics = validateDocumentStructure(
      documentWith([
        itemTemplate("torch", {
          fields: [
            {
              kind: "integer",
              id: "modifier",
              label: "Modifier",
              default: 0,
              required: false,
              min: -10,
              max: 20,
              step: 1,
            },
          ],
        }),
      ]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate_definition_id",
        path: "/templates/0/fields/0/id",
      }),
    );
  });

  it("flags a granted roll action with a missing expression", () => {
    const diagnostics = validateDocumentStructure(
      documentWith([itemTemplate("torch", { grantedActions: [rollAction("torch_attack", "missing_expr")] })]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_reference",
        path: "/templates/0/grantedActions/0/expressionId",
      }),
    );
  });

  it("flags a granted bump action with a missing template resource", () => {
    const diagnostics = validateDocumentStructure(
      documentWith([
        itemTemplate("torch", {
          grantedActions: [
            {
              kind: "resourceBump",
              id: "torch_refuel",
              label: "Refuel",
              resourceId: "missing_resource",
              operation: { kind: "delta", amount: 1 },
            },
          ],
        }),
      ]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_reference",
        path: "/templates/0/grantedActions/0/resourceId",
      }),
    );
  });

  it("flags a slot element referencing an unknown slot", () => {
    const doc = validDocument() as unknown as Record<string, unknown>;
    doc.templates = [];
    doc.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
    const sheets = doc.sheets as Record<string, unknown>[];
    const sections = (sheets[0] as Record<string, unknown>).sections as Record<string, unknown>[];
    (sections[0] as { elements: unknown[] }).elements.push({
      kind: "slot",
      id: "inv_element",
      slotId: "unknown_slot",
    });
    const diagnostics = validateDocumentStructure(doc as never);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "missing_reference",
        path: "/sheets/0/sections/0/elements/4/slotId",
      }),
    );
  });

  it("flags a template count over budget", () => {
    const templates = Array.from({ length: PACKAGE_LIMITS.templates + 1 }, (_, i) => ({
      id: `template_${i}`,
      label: "T",
      kind: "item",
      fields: [],
      grantedActions: [],
    }));
    const diagnostics = validateDocumentStructure(documentWith(templates));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded", path: "/templates" }),
    );
  });

  it("flags a slot count over budget", () => {
    const slots = Array.from({ length: PACKAGE_LIMITS.slots + 1 }, (_, i) => ({
      id: `slot_${i}`,
      label: "S",
      accepts: ["item"],
    }));
    const diagnostics = validateDocumentStructure(documentWith([], slots));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded", path: "/slots" }),
    );
  });

  it("flags template fields overflowing the global field budget", () => {
    const fields = Array.from({ length: 504 }, (_, i) => ({
      kind: "integer",
      id: `tf_${i}`,
      label: "F",
      default: 0,
      required: false,
      min: 0,
      max: 10,
      step: 1,
    }));
    const diagnostics = validateDocumentStructure(documentWith([itemTemplate("torch", { fields })]));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });

  it("flags granted actions overflowing the global action budget", () => {
    const grantedActions = Array.from({ length: 254 }, (_, i) => rollAction(`ga_${i}`));
    const diagnostics = validateDocumentStructure(
      documentWith([itemTemplate("torch", { grantedActions })]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });
});

describe("template/slot compatibility", () => {
  const torch = () =>
    itemTemplate("torch", { grantedActions: [rollAction("torch_attack"), rollAction("torch_attack_2")] });
  const inventory = (accepts: string[] = ["item"]) => ({ id: "inventory", label: "Inventory", accepts });

  it("flags template_removed when a template with live expressions disappears", () => {
    const report = comparePackages(packageWith([torch()], [inventory()]), packageWith([], [inventory()]));
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "template_removed", path: "/templates/torch" }),
    );
  });

  it("flags template_action_removed when a granted action disappears", () => {
    const next = itemTemplate("torch", { grantedActions: [rollAction("torch_attack")] });
    const report = comparePackages(packageWith([torch()], []), packageWith([next], []));
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "template_action_removed",
        path: "/templates/torch/grantedActions/torch_attack_2",
      }),
    );
  });

  it("flags slot_removed when a slot disappears", () => {
    const report = comparePackages(packageWith([], [inventory()]), packageWith([], []));
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "slot_removed", path: "/slots/inventory" }),
    );
  });

  it("flags slot_kind_narrowed when a slot accepts fewer kinds", () => {
    const report = comparePackages(
      packageWith([], [inventory(["item", "spell"])]),
      packageWith([], [inventory(["item"])]),
    );
    expect(report.compatible).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "slot_kind_narrowed", path: "/slots/inventory/accepts" }),
    );
  });

  it("treats adding templates, slots, and granted actions as non-breaking", () => {
    const report = comparePackages(
      packageWith([], []),
      packageWith([torch()], [inventory(["item", "spell"])]),
    );
    expect(report.compatible).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
