import { describe, expect, it } from "vitest";

import { compareExtensionPackages } from "../package/compatibility.js";
import { decodeExtensionDocument, decodeExtensionPackage } from "../package/extension.js";
import { derivedTemplateDocument } from "../package/fixtures/campaign-derived.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import type {
  ExtensionDocumentV1,
  ExtensionPackageV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import { compileDocument } from "./compile-document.js";
import { compileExtensionDocument, validateExtensionAgainst } from "./compile-extension.js";
import { composeRules } from "./compose.js";

const SYSTEM_ID = "a0000000-0000-4000-8000-000000000001";
const BASE_V1 = "a0000000-0000-4000-8000-000000000002";
const BASE_V2 = "a0000000-0000-4000-8000-000000000003";
const EXT_A = "e0000000-0000-4000-8000-00000000000a";
const EXT_B = "e0000000-0000-4000-8000-00000000000b";

function basePackage(versionId = BASE_V1, mutate?: (document: ReturnType<typeof derivedTemplateDocument>) => void): SystemPackageV1 {
  const document = derivedTemplateDocument();
  mutate?.(document);
  const result = compileDocument(document, { systemId: SYSTEM_ID, versionId, semanticVersion: "1.0.0" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

function extensionDocument(): ExtensionDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name: "Frost pack", description: "Cold weapons", language: "en" },
    expressions: [
      { id: "axe_hit_expr", context: "roll", resultType: "number", source: "d20 + fields.modifier + fields.edge + inputs.bonus", fallback: 0 },
      { id: "axe_total_expr", context: "computed", resultType: "number", source: "fields.edge * 2", fallback: 0 },
    ],
    templates: [{
      id: "frost_axe",
      kind: "item",
      label: "Frost axe",
      fields: [
        { id: "edge", kind: "integer", label: "Edge", default: 2, required: true, min: 0, max: 10, step: 1 },
        { id: "edge_total", kind: "computed", label: "Total", expressionId: "axe_total_expr", valueType: "number" },
      ],
      grantedActions: [{
        id: "axe_hit",
        kind: "roll",
        label: "Hit",
        expressionId: "axe_hit_expr",
        inputs: [{ id: "bonus", label: "Bonus", valueType: "integer", required: false, default: 0 }],
        outputTemplate: "Hit {total}",
      }],
    }],
  };
}

function compileExtension(
  document = extensionDocument(),
  base = basePackage(),
  extensionId = EXT_A,
  versionId = "e1000000-0000-4000-8000-000000000001",
): ExtensionPackageV1 {
  const result = compileExtensionDocument(document, base, { extensionId, versionId, semanticVersion: "1.0.0" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value.package;
}

describe("compileExtensionDocument", () => {
  it("compiles templates against the base and signs a decodable package", () => {
    const base = basePackage();
    const result = compileExtensionDocument(extensionDocument(), base, {
      extensionId: EXT_A,
      versionId: "e1000000-0000-4000-8000-000000000001",
      semanticVersion: "1.0.0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const extension = result.value.package;
    expect(result.value.warnings).toEqual([]);
    expect(extension.baseSystemId).toBe(SYSTEM_ID);
    expect(extension.builtAgainstVersionId).toBe(BASE_V1);
    expect(extension.expressions.map((expression) => expression.dependencies.toSorted()))
      .toEqual([["bonus", "edge", "modifier"], ["edge"]]);
    expect(decodeExtensionPackage(JSON.stringify(extension))).toEqual({ ok: true, value: extension });
  });

  it("rejects a tampered package checksum", () => {
    const extension = compileExtension();
    extension.templates[0]!.label = "Renamed";
    const decoded = decodeExtensionPackage(extension);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.diagnostics[0]!.code).toBe("checksum_mismatch");
  });

  it("rejects a reference to a character field the base does not expose", () => {
    const document = extensionDocument();
    document.expressions[0]!.source = "d20 + fields.luck";
    const result = compileExtensionDocument(document, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: "missing_reference", path: "/expressions/0" });
  });

  it("does not let a computed template field read character fields", () => {
    const document = extensionDocument();
    document.expressions[1]!.source = "fields.modifier";
    const result = compileExtensionDocument(document, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" });
    expect(result.ok).toBe(false);
  });

  it("does not let a granted roll read a computed template field the entry runtime cannot supply", () => {
    const document = extensionDocument();
    document.expressions[0]!.source = "d20 + fields.edge_total";
    const result = compileExtensionDocument(document, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: "missing_reference", path: "/expressions/0" });
  });

  it("warns when no base sheet slot accepts a template kind", () => {
    const document = extensionDocument();
    document.templates[0]!.kind = "spell";
    // An unplaceable kind exposes no character fields to its granted rolls.
    document.expressions[0]!.source = "d20 + fields.edge";
    const result = compileExtensionDocument(document, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([expect.objectContaining({ code: "template_kind_unplaceable", path: "/templates/0/kind" })]);
  });

  it("rejects validation expressions, duplicate IDs and shared expressions", () => {
    const validation = extensionDocument();
    validation.expressions.push({ id: "check", context: "validation", resultType: "boolean", source: "true", fallback: true });
    expect(decodeExtensionDocument(validation).ok).toBe(false);
    expect(compileExtensionDocument(validation, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" }).ok).toBe(false);

    const duplicate = extensionDocument();
    duplicate.templates.push(structuredClone(duplicate.templates[0]!));
    const decoded = decodeExtensionDocument(duplicate);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("duplicate_definition_id");

    const shared = extensionDocument();
    shared.templates[0]!.fields[1] = { id: "edge_total", kind: "computed", label: "Total", expressionId: "axe_hit_expr", valueType: "number" };
    expect(compileExtensionDocument(shared, basePackage(), { extensionId: EXT_A, versionId: EXT_A, semanticVersion: "1.0.0" }).ok).toBe(false);
  });

  it("accepts push policies on named dice groups", () => {
    const document = extensionDocument();
    document.expressions[0]!.source = 'countSuccesses(group("attribute", "Attribute", dice(fields.ability, 6)), 6)';
    const action = document.templates[0]!.grantedActions[0]!;
    if (action.kind !== "roll") throw new Error("roll expected");
    action.pushPolicy = {
      version: "1.0",
      maxAttempts: 2,
      successThreshold: 1,
      allowOnSuccess: true,
      groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
    };
    expect(compileExtension(document).templates[0]!.grantedActions[0]).toHaveProperty("pushPolicy");
  });
});

describe("validateExtensionAgainst", () => {
  it("accepts a later base version that keeps the fields used", () => {
    const later = basePackage(BASE_V2, (document) => {
      document.entities[0]!.fields.push({ id: "luck", kind: "integer", label: "Luck", default: 0, required: false, min: 0, max: 5, step: 1 });
    });
    expect(validateExtensionAgainst(later, compileExtension()).ok).toBe(true);
  });

  it("rejects a base version without a field the extension reads", () => {
    // V2 moves the inventory slot to the NPC sheet, whose entity has no
    // `modifier` field, so the extension's granted roll no longer fits.
    const narrowed = basePackage(BASE_V2, (document) => {
      const pcSection = document.sheets[0]!.sections[0]!;
      const slot = pcSection.elements.find((element) => element.kind === "slot")!;
      pcSection.elements = pcSection.elements.filter((element) => element !== slot);
      document.sheets[1]!.sections[0]!.elements.push(slot);
      document.templates = [];
      document.expressions = document.expressions.filter((expression) => !expression.id.startsWith("sword_"));
    });
    const result = validateExtensionAgainst(narrowed, compileExtension());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: "extension_incompatible", path: "/expressions/0" });
  });

  it("rejects an extension for another system", () => {
    const extension = compileExtension();
    const other = { ...basePackage(), systemId: "b0000000-0000-4000-8000-000000000001" };
    const result = validateExtensionAgainst(other, extension);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.code).toBe("extension_base_mismatch");
  });
});

describe("composeRules", () => {
  it("scopes template and expression IDs by origin", () => {
    const base = basePackage();
    const clash = extensionDocument();
    clash.templates[0]!.id = "sword";
    clash.templates[0]!.label = "Frost sword";
    const a = compileExtension(clash, base, EXT_A);
    const b = compileExtension(clash, base, EXT_B, "e2000000-0000-4000-8000-000000000001");
    const result = composeRules(base, [b, a]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rules = result.value;
    expect(rules.template(null, "sword")?.label).toBe("Longsword");
    expect(rules.template(EXT_A, "sword")?.label).toBe("Frost sword");
    expect(rules.template(EXT_B, "sword")?.label).toBe("Frost sword");
    expect(rules.expression(EXT_A, "axe_hit_expr")?.context).toBe("roll");
    expect(rules.expression(null, "axe_hit_expr")).toBeUndefined();
    expect(rules.template(EXT_A, "missing")).toBeUndefined();
    expect(rules.templates().map(({ origin }) => origin)).toEqual([null, EXT_A, EXT_B]);
    expect(rules.identity.extensions.map((extension) => extension.extensionId)).toEqual([EXT_A, EXT_B]);
  });

  it("has an order-independent checksum that follows versions", () => {
    const base = basePackage();
    const a = compileExtension(undefined, base, EXT_A);
    const b = compileExtension(undefined, base, EXT_B, "e2000000-0000-4000-8000-000000000001");
    const ab = composeRules(base, [a, b]);
    const ba = composeRules(base, [b, a]);
    const a2 = compileExtension(undefined, base, EXT_A, "e1000000-0000-4000-8000-000000000002");
    const changed = composeRules(base, [a2, b]);
    const baseOnly = composeRules(base, []);
    if (!ab.ok || !ba.ok || !changed.ok || !baseOnly.ok) throw new Error("composition failed");
    expect(ab.value.compositionChecksum).toBe(ba.value.compositionChecksum);
    expect(changed.value.compositionChecksum).not.toBe(ab.value.compositionChecksum);
    expect(baseOnly.value.compositionChecksum).not.toBe(ab.value.compositionChecksum);
  });

  it("rejects two versions of one extension, too many extensions and incompatible ones", () => {
    const base = basePackage();
    const a1 = compileExtension(undefined, base, EXT_A);
    const a2 = compileExtension(undefined, base, EXT_A, "e1000000-0000-4000-8000-000000000002");
    const twice = composeRules(base, [a1, a2]);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.diagnostics[0]!.code).toBe("duplicate_extension");

    const many = Array.from({ length: PACKAGE_LIMITS.extensionsPerComposition + 1 }, (_, index) =>
      compileExtension(undefined, base, `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    const tooMany = composeRules(base, many);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.diagnostics[0]!.code).toBe("limit_exceeded");

    const foreign = { ...base, systemId: "b0000000-0000-4000-8000-000000000001" };
    const mismatch = composeRules(foreign, [a1]);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.diagnostics[0]!.path).toBe(`/extensions/${EXT_A}/baseSystemId`);
  });

  it("reports per-extension warnings with their origin", () => {
    const document = extensionDocument();
    document.templates[0]!.kind = "talent";
    document.expressions[0]!.source = "d20 + fields.edge";
    const result = composeRules(basePackage(), [compileExtension(document)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.warnings[0]!.path).toBe(`/extensions/${EXT_A}/templates/0/kind`);
  });
});

describe("compareExtensionPackages", () => {
  it("treats added templates as compatible and removed ones as breaking", () => {
    const base = basePackage();
    const v1 = compileExtension(undefined, base);
    const addedDocument = extensionDocument();
    addedDocument.templates.push({ ...structuredClone(addedDocument.templates[0]!), id: "ice_shield", label: "Ice shield", grantedActions: [], fields: [] });
    const added = compileExtension(addedDocument, base, EXT_A, "e1000000-0000-4000-8000-000000000002");
    expect(compareExtensionPackages(v1, added)).toEqual({ compatible: true, findings: [] });

    const removedField = extensionDocument();
    removedField.templates[0]!.fields = removedField.templates[0]!.fields.filter((field) => field.id !== "edge");
    removedField.expressions = [{ ...removedField.expressions[0]!, source: "d20 + fields.modifier" }];
    removedField.templates[0]!.fields = [];
    const narrowed = compileExtension(removedField, base, EXT_A, "e1000000-0000-4000-8000-000000000003");
    expect(compareExtensionPackages(v1, narrowed).findings.map((finding) => finding.code))
      .toEqual(["template_field_removed", "template_field_removed"]);
    expect(compareExtensionPackages(added, v1).findings.map((finding) => finding.code)).toEqual(["template_removed"]);
  });

  it("flags versions of different extensions", () => {
    const base = basePackage();
    const report = compareExtensionPackages(compileExtension(undefined, base, EXT_A), compileExtension(undefined, base, EXT_B));
    expect(report.findings.map((finding) => finding.code)).toEqual(["extension_identity_changed"]);
  });
});
