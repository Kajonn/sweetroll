import { describe, expect, it } from "vitest";

import { PACKAGE_LIMITS } from "./limits.js";
import {
  decodeSystemDocument,
  decodeSystemExport,
  decodeSystemPackage,
} from "./codec.js";
import {
  validDocument,
  validSignedShapePackage,
} from "./schema/test-values.js";
import type { ExpressionAstV1 } from "./schema/expression.js";

describe("system package codecs", () => {
  it("decodes object and UTF-8 byte document inputs into isolated values", () => {
    const document = validDocument();
    const objectResult = decodeSystemDocument(document);
    const bytesResult = decodeSystemDocument(
      new TextEncoder().encode(JSON.stringify(document)),
    );

    expect(objectResult).toEqual({ ok: true, value: document });
    expect(bytesResult.ok).toBe(true);
    expect(objectResult.ok && objectResult.value).not.toBe(document);

    document.metadata.name = "Changed by caller";
    expect(objectResult.ok && objectResult.value.metadata.name).toBe("Pocket Quest");
  });

  it("rejects invalid JSON and invalid UTF-8 without throwing", () => {
    const expected = {
      ok: false,
      diagnostics: [
        { code: "invalid_json", path: "", message: "Input is not valid JSON." },
      ],
    };

    expect(decodeSystemDocument("{")).toEqual(expected);
    expect(decodeSystemDocument(new Uint8Array([0xff]))).toEqual(expected);
  });

  it("rejects encoded input before parsing when it exceeds one MiB", () => {
    expect(
      decodeSystemDocument(new Uint8Array(PACKAGE_LIMITS.encodedBytes + 1)),
    ).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "document_too_large",
          path: "",
          message: "Input exceeds 1048576 bytes.",
        },
      ],
    });
  });

  it("returns invalid results instead of throwing for hostile caller-controlled inputs", () => {
    const byteProxy = new Proxy(new Uint8Array(0), {});
    const hostileObject = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const expected = {
      ok: false,
      diagnostics: [
        {
          code: "invalid_schema",
          path: "",
          message: "Input does not match the required schema.",
        },
      ],
    };

    for (const decode of [decodeSystemDocument, decodeSystemPackage, decodeSystemExport]) {
      expect(() => decode(byteProxy)).not.toThrow();
      expect(decode(byteProxy)).toEqual(expected);
      expect(() => decode(hostileObject)).not.toThrow();
      expect(decode(hostileObject)).toEqual(expected);
    }
  });

  it("maps unknown properties and malformed IDs to exact JSON Pointers", () => {
    const unknown = { ...validDocument(), "extra/property~": true };
    const malformed = validDocument();
    malformed.entities[0]!.id = "Bad-ID";

    expect(decodeSystemDocument(unknown)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "invalid_schema",
          path: "/extra~1property~0",
          message: "Input does not match the required schema.",
        },
      ],
    });
    expect(decodeSystemDocument(malformed)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "invalid_definition_id",
          path: "/entities/0/id",
          message: "Definition ID is invalid.",
        },
      ],
    });
  });

  it("rejects expression source above the UTF-8 byte ceiling", () => {
    const document = validDocument();
    document.expressions[0]!.source = "é".repeat(513);

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "limit_exceeded",
          path: "/expressions/0/source",
          message: "Expression source exceeds 1024 bytes.",
        },
      ],
    });
  });

  it("enforces aggregate field and sheet-element ceilings", () => {
    const fieldsDocument = validDocument();
    const field = fieldsDocument.entities[0]!.fields[0]!;
    fieldsDocument.entities = [
      { id: "first", label: "First", fields: Array.from({ length: 256 }, (_, index) => ({ ...field, id: `a${index}` })) },
      { id: "second", label: "Second", fields: Array.from({ length: 257 }, (_, index) => ({ ...field, id: `b${index}` })) },
    ];

    const elementsDocument = validDocument();
    const firstSection = elementsDocument.sheets[0]!.sections[0]!;
    const heading = { kind: "heading" as const, id: "heading", text: "Heading", level: 2 as const };
    elementsDocument.sheets = [
      {
        id: "first_sheet",
        label: "First",
        targetEntityId: "character",
        sections: [{ ...firstSection, id: "first_section", elements: Array.from({ length: 512 }, (_, index) => ({ ...heading, id: `a${index}` })) }],
      },
      {
        id: "second_sheet",
        label: "Second",
        targetEntityId: "character",
        sections: [{ ...firstSection, id: "second_section", elements: Array.from({ length: 513 }, (_, index) => ({ ...heading, id: `b${index}` })) }],
      },
    ];

    expect(decodeSystemDocument(fieldsDocument)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/entities/1/fields", message: "Document contains more than 512 fields." }],
    });
    expect(decodeSystemDocument(elementsDocument)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/sheets/1/sections/0/elements", message: "Document contains more than 1024 sheet elements." }],
    });
  });

  it("escapes malformed reference-data keys in definition diagnostics", () => {
    const document = validDocument();
    document.referenceData[0]!.records[0]!.values = { "Bad/key~": true };

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "invalid_schema",
          path: "/referenceData/0/records/0/values/Bad~1key~0",
          message: "Input does not match the required schema.",
        },
      ],
    });
  });

  it("reports cross-kind duplicate IDs after their first occurrence", () => {
    const document = validDocument();
    document.actions[0]!.id = document.entities[0]!.id;
    const actionElement = document.sheets[0]!.sections[0]!.elements[3]!;
    if (actionElement.kind === "action") actionElement.actionId = document.entities[0]!.id;

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "duplicate_definition_id",
          path: "/actions/0/id",
          message: "Definition ID must be unique.",
        },
      ],
    });
  });

  it("reports every missing sheet target at its reference property", () => {
    const document = validDocument();
    document.sheets[0]!.targetEntityId = "missing_entity";
    document.sheets[0]!.sections[0]!.elements.push(
      { kind: "field", id: "missing_field_element", fieldId: "missing_field" },
      { kind: "resource", id: "missing_resource_element", resourceId: "modifier" },
      { kind: "action", id: "missing_action_element", actionId: "missing_action" },
    );

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        { code: "missing_reference", path: "/sheets/0/sections/0/elements/4/fieldId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/sheets/0/sections/0/elements/5/resourceId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/sheets/0/sections/0/elements/6/actionId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/sheets/0/targetEntityId", message: "Referenced definition does not exist." },
      ],
    });
  });

  it("resolves computed, roll, validation, and resource-bump references", () => {
    const document = validDocument();
    const computed = document.entities[0]!.fields.find((field) => field.kind === "computed")!;
    const roll = document.actions.find((action) => action.kind === "roll")!;
    const bump = document.actions.find((action) => action.kind === "resourceBump")!;
    computed.expressionId = "missing_computed_expression";
    roll.expressionId = "missing_roll_expression";
    bump.resourceId = "modifier";
    document.validations[0]!.expressionId = "missing_validation_expression";
    document.validations[0]!.targetId = "missing_validation_target";

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        { code: "missing_reference", path: "/actions/0/expressionId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/actions/1/resourceId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/entities/0/fields/7/expressionId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/validations/0/expressionId", message: "Referenced definition does not exist." },
        { code: "missing_reference", path: "/validations/0/targetId", message: "Referenced definition does not exist." },
      ],
    });
  });

  it("rejects package ASTs above the node and depth ceilings", () => {
    const nodesPackage = validSignedShapePackage();
    nodesPackage.expressions[0]!.ast = binaryTree(8);
    const depthPackage = validSignedShapePackage();
    depthPackage.expressions[0]!.ast = unaryChain(32);

    expect(decodeSystemPackage(nodesPackage)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/expressions/0/ast", message: "Expression AST exceeds 256 nodes." }],
    });
    expect(decodeSystemPackage(depthPackage)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/expressions/0/ast", message: "Expression AST exceeds depth 32." }],
    });
  });

  it("preflights deeply nested package and export ASTs before recursive schema validation", () => {
    const packageValue = validSignedShapePackage();
    packageValue.expressions[0]!.ast = unaryChain(1_000);
    const exportValue = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.system+json;version=1",
      exportedAt: "2026-09-04T12:00:00Z",
      package: packageValue,
    };

    expect(decodeSystemPackage(packageValue)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "limit_exceeded",
          path: "/expressions/0/ast",
          message: "Expression AST exceeds depth 32.",
        },
      ],
    });
    expect(decodeSystemExport(exportValue)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "limit_exceeded",
          path: "/package/expressions/0/ast",
          message: "Expression AST exceeds depth 32.",
        },
      ],
    });
  });

  it("rejects effective package limits above platform ceilings", () => {
    const value = validSignedShapePackage() as unknown as Record<string, unknown>;
    (value.effectiveLimits as Record<string, number>).dicePerRoll = 101;
    const exportValue = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.system+json;version=1",
      exportedAt: "2026-09-04T12:00:00Z",
      package: value,
    };

    expect(decodeSystemPackage(value)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/effectiveLimits/dicePerRoll", message: "Effective limit exceeds the platform ceiling." }],
    });
    expect(decodeSystemExport(exportValue)).toEqual({
      ok: false,
      diagnostics: [{ code: "limit_exceeded", path: "/package/effectiveLimits/dicePerRoll", message: "Effective limit exceeds the platform ceiling." }],
    });
  });

  it("orders and deduplicates diagnostics by path then code", () => {
    const document = validDocument();
    document.actions[0]!.id = "character";
    document.actions[1]!.id = "character";
    const bump = document.actions[1]!;
    if (bump.kind === "resourceBump") bump.resourceId = "missing";
    const actionElement = document.sheets[0]!.sections[0]!.elements[3]!;
    if (actionElement.kind === "action") actionElement.actionId = "character";

    expect(decodeSystemDocument(document)).toEqual({
      ok: false,
      diagnostics: [
        { code: "duplicate_definition_id", path: "/actions/0/id", message: "Definition ID must be unique." },
        { code: "duplicate_definition_id", path: "/actions/1/id", message: "Definition ID must be unique." },
        { code: "missing_reference", path: "/actions/1/resourceId", message: "Referenced definition does not exist." },
      ],
    });
  });

  it("validates export package structure with envelope-prefixed paths", () => {
    const packageValue = validSignedShapePackage();
    packageValue.sheets[0]!.targetEntityId = "missing";
    const value = {
      schemaVersion: "1.0" as const,
      mediaType: "application/vnd.sweetroll.system+json;version=1" as const,
      exportedAt: "2026-09-04T12:00:00Z",
      package: packageValue,
    };

    expect(decodeSystemExport(value)).toEqual({
      ok: false,
      diagnostics: [{ code: "missing_reference", path: "/package/sheets/0/targetEntityId", message: "Referenced definition does not exist." }],
    });
  });
});

function unaryChain(operators: number): ExpressionAstV1 {
  let ast: ExpressionAstV1 = {
    kind: "numberLiteral",
    value: 1,
  };
  for (let index = 0; index < operators; index += 1) {
    ast = { kind: "unary", operator: "-", operand: ast };
  }
  return ast;
}

function binaryTree(levels: number): ExpressionAstV1 {
  if (levels === 0) return { kind: "numberLiteral", value: 1 };
  return {
    kind: "binary",
    operator: "+",
    left: binaryTree(levels - 1),
    right: binaryTree(levels - 1),
  };
}
