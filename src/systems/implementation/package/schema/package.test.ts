import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { PACKAGE_LIMITS } from "../limits.js";
import { SystemExportV1Schema } from "./export.js";
import { SystemPackageV1Schema } from "./package.js";
import { validSignedShapePackage } from "./test-values.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validatePackage = ajv.compile(SystemPackageV1Schema);
const validateExport = ajv.compile(SystemExportV1Schema);

function exportEnvelope() {
  return {
    schemaVersion: "1.0",
    mediaType: "application/vnd.sweetroll.system+json;version=1",
    exportedAt: "2026-09-04T12:34:56.789Z",
    provenance: { sourceUrl: "https://example.test/system", license: "Original" },
    package: packageWithEveryAstVariant(),
  };
}

function packageWithEveryAstVariant() {
  const value = validSignedShapePackage();
  value.expressions.push(
    {
      id: "string_expr",
      resultType: "text",
      inferredType: "text",
      fallback: "",
      dependencies: [],
      cost: 1,
      ast: { kind: "stringLiteral", value: "ready" },
    },
    {
      id: "boolean_expr",
      resultType: "boolean",
      inferredType: "boolean",
      fallback: false,
      dependencies: [],
      cost: 1,
      ast: { kind: "booleanLiteral", value: true },
    },
    {
      id: "unary_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 2,
      ast: { kind: "unary", operator: "-", operand: { kind: "numberLiteral", value: 1 } },
    },
    {
      id: "min_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 3,
      ast: {
        kind: "call",
        function: "min",
        arguments: [
          { kind: "numberLiteral", value: 1 },
          { kind: "numberLiteral", value: 2 },
        ],
      },
    },
    {
      id: "max_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 3,
      ast: {
        kind: "call",
        function: "max",
        arguments: [
          { kind: "numberLiteral", value: 1 },
          { kind: "numberLiteral", value: 2 },
        ],
      },
    },
    {
      id: "round_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 2,
      ast: {
        kind: "call",
        function: "round",
        arguments: [{ kind: "numberLiteral", value: 1.5 }],
        roundMode: "down",
      },
    },
    {
      id: "dice_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 2,
      ast: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
    },
    {
      id: "keep_high_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 3,
      ast: {
        kind: "keep",
        mode: "highest",
        count: 1,
        dice: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 20 },
      },
    },
    {
      id: "keep_low_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: [],
      cost: 3,
      ast: {
        kind: "keep",
        mode: "lowest",
        count: 1,
        dice: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 20 },
      },
    },
    {
      id: "input_expr",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: ["bonus"],
      cost: 1,
      ast: { kind: "reference", scope: "inputs", id: "bonus" },
    },
  );
  return value;
}

describe("compiled package schemas", () => {
  it("accepts a package containing every AST variant", () => {
    expect(validatePackage(packageWithEveryAstVariant())).toBe(true);
  });

  it("accepts a portable export envelope", () => {
    expect(validateExport(exportEnvelope())).toBe(true);
  });

  it("rejects an unknown AST kind", () => {
    const value = validSignedShapePackage();
    value.expressions[0]!.ast = { kind: "unknown" } as never;

    expect(validatePackage(value)).toBe(false);
  });

  it("rejects die sides above the platform ceiling", () => {
    const value = validSignedShapePackage();
    value.expressions[0]!.ast = {
      kind: "dice",
      count: { kind: "numberLiteral", value: 1 },
      sides: 1001,
    };

    expect(validatePackage(value)).toBe(false);
  });

  it("rejects compiled expression cost 257", () => {
    const value = validSignedShapePackage();
    value.expressions[0]!.cost = 257;

    expect(validatePackage(value)).toBe(false);
  });

  it("rejects a malformed checksum", () => {
    const value = validSignedShapePackage();
    value.integrity.checksum = "sha256:not-a-checksum";

    expect(validatePackage(value)).toBe(false);
  });

  it("rejects an account-shaped export property", () => {
    expect(validateExport({ ...exportEnvelope(), ownerId: "account-1" })).toBe(false);
  });

  it("rejects any other export media type", () => {
    expect(validateExport({ ...exportEnvelope(), mediaType: "application/json" })).toBe(false);
  });

  it("enforces recursive AST collection ceilings", () => {
    const tooManyArguments = validSignedShapePackage();
    tooManyArguments.expressions[0]!.ast = {
      kind: "call",
      function: "max",
      arguments: Array.from({ length: 3 }, () => ({ kind: "numberLiteral", value: 1 })),
    };
    expect(validatePackage(tooManyArguments)).toBe(false);

    const tooManyKeptDice = validSignedShapePackage();
    tooManyKeptDice.expressions[0]!.ast = {
      kind: "keep",
      mode: "highest",
      count: PACKAGE_LIMITS.dicePerRoll + 1,
      dice: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
    };
    expect(validatePackage(tooManyKeptDice)).toBe(false);
  });
});
