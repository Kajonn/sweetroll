import { describe, expect, it } from "vitest";
import { d20Document, d20Package, d6SuccessPoolDocument, d6SuccessPoolPackage, pbta2d6Document, pbta2d6Package } from "../package/fixtures/index.js";
import { validDocument } from "../package/schema/test-values.js";
import type { SystemDocumentV1 } from "../package/schema/index.js";
import { compileDocument } from "./compile-document.js";

const opts = { systemId: "a0000000-0000-5000-8000-000000000001", versionId: "a0000000-0000-5000-8000-000000000002", semanticVersion: "1.0.0" };

describe("compileDocument", () => {
  it("reproduces the d20 package fixture", () => {
    const r = compileDocument(d20Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions).toHaveLength(3);
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
    expect(r.value.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(d20Package.expressions[i]!.ast);
    }
  });

  it("compiles the 2d6 document", () => {
    const r = compileDocument(pbta2d6Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(pbta2d6Package.expressions[i]!.ast);
    }
  });

  it("compiles the d6 pool document", () => {
    const r = compileDocument(d6SuccessPoolDocument, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 7, 7]);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(d6SuccessPoolPackage.expressions[i]!.ast);
    }
  });

  it("rejects a document with an invalid expression", () => {
    const bad = structuredClone(d20Document);
    bad.expressions[0]!.source = "fields.nope + 1";
    const r = compileDocument(bad, opts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("missing_reference");
  });

  it("preserves the expression context in compiled expressions", () => {
    const result = compileDocument(d20Document, {
      systemId: "00000000-0000-4000-8000-000000000000",
      versionId: "00000000-0000-4000-8000-000000000001",
      semanticVersion: "1.0.0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compilation failed");
    expect(result.value.expressions.map((e) => e.context)).toEqual(["computed", "roll", "validation"]);
  });

  it("rejects a sheet field from another entity at the element field path", () => {
    const document = twoEntityDocument();
    document.sheets[0]!.sections[0]!.elements.push({
      kind: "field",
      id: "foreign_field_element",
      fieldId: "foe_rank",
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "missing_reference",
        path: "/sheets/0/sections/0/elements/4/fieldId",
        message: "Field does not belong to the sheet target entity.",
      }],
    });
  });

  it("rejects an action referenced by sheets targeting multiple entities", () => {
    const document = twoEntityDocument();
    document.sheets[1]!.sections[0]!.elements.push({
      kind: "action",
      id: "foreign_check_element",
      actionId: "check",
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "invalid_expression",
        path: "/sheets/1/sections/0/elements/1/actionId",
        message: "Action cannot target multiple entities.",
      }],
    });
  });

  it("rejects a roll expression using an input owned by another action", () => {
    const document = twoEntityDocument();
    document.actions.push({
      kind: "roll",
      id: "foe_check",
      label: "Foe check",
      expressionId: "foe_check_expr",
      inputs: [{
        id: "foe_bonus",
        label: "Foe bonus",
        valueType: "integer",
        required: false,
        default: 0,
      }],
      outputTemplate: "Result: {total}",
    });
    document.expressions.push({
      id: "foe_check_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.foe_rank",
      fallback: 0,
    });
    document.sheets[1]!.sections[0]!.elements.push({
      kind: "action",
      id: "foe_check_element",
      actionId: "foe_check",
    });
    document.expressions.find((expression) => expression.id === "check_expr")!.source =
      "d20 + fields.modifier + inputs.foe_bonus";

    const result = compileDocument(document, opts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([{
      code: "missing_reference",
      path: "check_expr",
      message: "unknown inputs reference 'foe_bonus'",
    }]);
  });

  it("rejects a computed expression using a field owned by another entity", () => {
    const document = twoEntityDocument();
    document.expressions.find((expression) => expression.id === "defense_expr")!.source =
      "10 + fields.foe_rank";

    const result = compileDocument(document, opts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([{
      code: "missing_reference",
      path: "defense_expr",
      message: "unknown fields reference 'foe_rank'",
    }]);
  });

  it("compiles an entity-targeted validation against that entity's fields", () => {
    const document = twoEntityDocument();
    for (const validation of document.validations) validation.targetId = "character";

    const result = compileDocument(document, opts);

    expect(result.ok).toBe(true);
  });

  it("rejects a resource action placed on another entity's sheet", () => {
    const document = twoEntityDocument();
    document.sheets[1]!.sections[0]!.elements.push({
      kind: "action",
      id: "foreign_heal_element",
      actionId: "heal",
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "missing_reference",
        path: "/sheets/1/sections/0/elements/1/actionId",
        message: "Action does not belong to the sheet target entity.",
      }],
    });
  });

  it("rejects cyclic computed dependencies", () => {
    const document = validDocument();
    document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
    document.entities[0]!.fields.push(
      {
        kind: "computed",
        id: "attack",
        label: "Attack",
        valueType: "number",
        expressionId: "attack_expr",
      },
    );
    document.expressions.find((expression) => expression.id === "defense_expr")!.source =
      "fields.attack + 1";
    document.expressions.push({
      id: "attack_expr",
      context: "computed",
      resultType: "number",
      source: "fields.defense + 1",
      fallback: 0,
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "invalid_expression",
        path: "attack_expr",
        message: "Computed field dependency cycle detected.",
      }],
    });
  });

  it("rejects a computed expression reused by fields owned by different entities", () => {
    const document = twoEntityDocument();
    document.entities[1]!.fields.push({
      kind: "computed",
      id: "foe_defense",
      label: "Defense",
      valueType: "number",
      expressionId: "defense_expr",
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "invalid_expression",
        path: "defense_expr",
        message: "Expression cannot be shared across different owners.",
      }],
    });
  });

  it("rejects a roll expression reused by different actions", () => {
    const document = twoEntityDocument();
    document.actions.push({
      kind: "roll",
      id: "foe_check",
      label: "Foe check",
      expressionId: "check_expr",
      inputs: [{
        id: "bonus",
        label: "Bonus",
        valueType: "integer",
        required: false,
        default: 0,
      }],
      outputTemplate: "Result: {total}",
    });
    document.sheets[1]!.sections[0]!.elements.push({
      kind: "action",
      id: "foe_check_element",
      actionId: "foe_check",
    });

    const result = compileDocument(document, opts);

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: "invalid_expression",
        path: "check_expr",
        message: "Expression cannot be shared across different owners.",
      }],
    });
  });
});

function twoEntityDocument(): SystemDocumentV1 {
  const document = validDocument();
  document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
  document.entities.push({
    id: "foe",
    label: "Foe",
    fields: [{
      kind: "integer",
      id: "foe_rank",
      label: "Rank",
      default: 1,
      required: true,
      min: 1,
      max: 10,
      step: 1,
    }],
  });
  document.sheets.push({
    id: "foe_sheet",
    label: "Foe",
    targetEntityId: "foe",
    sections: [{
      id: "foe_main",
      label: "Main",
      elements: [{ kind: "field", id: "foe_rank_element", fieldId: "foe_rank" }],
    }],
  });
  return document;
}
