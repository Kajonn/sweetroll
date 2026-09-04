import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { PACKAGE_LIMITS } from "../limits.js";
import { SystemDocumentV1Schema, type SystemDocumentV1 } from "./document.js";

const validate = new Ajv({ allErrors: true, strict: true }).compile(SystemDocumentV1Schema);

function document(): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: {
      name: "Pocket Quest",
      description: "Original fixture",
      language: "en",
      defaultDice: "d20",
    },
    entities: [
      {
        id: "character",
        label: "Character",
        fields: [
          {
            kind: "text",
            id: "name",
            label: "Name",
            default: "",
            required: true,
            minLength: 1,
            maxLength: 120,
          },
          {
            kind: "integer",
            id: "modifier",
            label: "Modifier",
            default: 0,
            required: true,
            min: -10,
            max: 20,
            step: 1,
          },
          {
            kind: "decimal",
            id: "speed",
            label: "Speed",
            default: 1.5,
            required: true,
            min: 0,
            max: 10,
            step: 0.5,
          },
          {
            kind: "boolean",
            id: "ready",
            label: "Ready",
            default: false,
            required: true,
          },
          {
            kind: "singleChoice",
            id: "role",
            label: "Role",
            required: false,
            default: null,
            options: [{ id: "scout", label: "Scout" }],
          },
          {
            kind: "multiChoice",
            id: "talents",
            label: "Talents",
            required: false,
            default: ["keen"],
            options: [{ id: "keen", label: "Keen" }],
          },
          {
            kind: "resource",
            id: "health",
            label: "Health",
            default: { current: 6, max: 6 },
            min: 0,
            max: 20,
            step: 1,
            resetTo: "max",
          },
          {
            kind: "computed",
            id: "defense",
            label: "Defense",
            valueType: "number",
            expressionId: "defense_expr",
          },
          { kind: "image", id: "portrait", label: "Portrait", required: false },
        ],
      },
    ],
    referenceData: [],
    sheets: [
      {
        id: "character_sheet",
        label: "Character",
        targetEntityId: "character",
        sections: [
          {
            id: "main",
            label: "Main",
            elements: [
              { kind: "heading", id: "stats_heading", text: "Stats", level: 2 },
              { kind: "field", id: "modifier_element", fieldId: "modifier" },
              { kind: "resource", id: "health_element", resourceId: "health" },
              { kind: "action", id: "check_element", actionId: "check" },
            ],
          },
        ],
      },
    ],
    expressions: [
      {
        id: "defense_expr",
        context: "computed",
        resultType: "number",
        source: "10 + fields.modifier",
        fallback: 10,
      },
      {
        id: "title_expr",
        context: "computed",
        resultType: "text",
        source: '"Adventurer"',
        fallback: "Adventurer",
      },
      {
        id: "check_expr",
        context: "roll",
        resultType: "number",
        source: "d20 + fields.modifier + inputs.bonus",
        fallback: 0,
      },
      {
        id: "health_valid_expr",
        context: "validation",
        resultType: "boolean",
        source: "fields.health >= 0",
        fallback: false,
      },
    ],
    actions: [
      {
        kind: "roll",
        id: "check",
        label: "Check",
        expressionId: "check_expr",
        inputs: [
          {
            id: "bonus",
            label: "Bonus",
            valueType: "integer",
            required: false,
            default: 0,
          },
        ],
        outputTemplate: "Result: {total}",
      },
      {
        kind: "resourceBump",
        id: "heal",
        label: "Heal",
        resourceId: "health",
        operation: { kind: "delta", amount: 1 },
      },
      {
        kind: "resourceBump",
        id: "rest",
        label: "Rest",
        resourceId: "health",
        operation: { kind: "reset" },
      },
    ],
    validations: [
      {
        id: "health_valid",
        expressionId: "health_valid_expr",
        severity: "error",
        message: "Health must be non-negative",
        targetId: "health",
      },
      {
        id: "health_warning",
        expressionId: "health_valid_expr",
        severity: "warning",
        message: "Health is low",
        targetId: "health",
      },
    ],
  };
}

describe("SystemDocumentV1Schema", () => {
  it("accepts the editable v1 document and every represented tagged variant", () => {
    expect(validate(document())).toBe(true);
  });

  it.each([
    ["unknown root property", { ...document(), extra: true }],
    ["bad schema version", { ...document(), schemaVersion: "2.0" }],
    [
      "malformed definition id",
      {
        ...document(),
        entities: [{ ...document().entities[0]!, id: "Bad-ID" }],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(validate(value)).toBe(false);
  });

  it("rejects an expression over the byte ceiling", () => {
    const value = document();
    value.expressions[0] = {
      ...value.expressions[0]!,
      source: "x".repeat(PACKAGE_LIMITS.expressionBytes + 1),
    };
    expect(validate(value)).toBe(false);
  });
});
