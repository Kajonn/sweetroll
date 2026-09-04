import { PACKAGE_LIMITS } from "../limits.js";
import type { SystemDocumentV1 } from "./document.js";
import type { CompiledExpressionV1 } from "./expression.js";
import type { SystemPackageV1, UnsignedSystemPackageV1 } from "./package.js";

export function validDocument(): SystemDocumentV1 {
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
    referenceData: [
      {
        id: "creatures",
        label: "Creatures",
        records: [
          {
            id: "slime",
            label: "Slime",
            values: {
              description: "A wobbling nuisance",
              health: 3,
              hostile: true,
              weakness: null,
            },
          },
        ],
      },
    ],
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

const expressions: CompiledExpressionV1[] = [
  {
    id: "literal_expr",
    resultType: "number",
    inferredType: "number",
    fallback: 0,
    dependencies: [],
    cost: 1,
    ast: { kind: "numberLiteral", value: 1 },
  },
  {
    id: "reference_expr",
    resultType: "number",
    inferredType: "number",
    fallback: 0,
    dependencies: ["modifier"],
    cost: 1,
    ast: { kind: "reference", scope: "fields", id: "modifier" },
  },
  {
    id: "binary_expr",
    resultType: "number",
    inferredType: "number",
    fallback: 0,
    dependencies: ["modifier"],
    cost: 3,
    ast: {
      kind: "binary",
      operator: "+",
      left: { kind: "numberLiteral", value: 10 },
      right: { kind: "reference", scope: "fields", id: "modifier" },
    },
  },
  {
    id: "pool_expr",
    resultType: "number",
    inferredType: "number",
    fallback: 0,
    dependencies: ["attribute", "skill"],
    cost: 7,
    ast: {
      kind: "successCount",
      dice: {
        kind: "dice",
        count: {
          kind: "binary",
          operator: "+",
          left: { kind: "reference", scope: "fields", id: "attribute" },
          right: { kind: "reference", scope: "fields", id: "skill" },
        },
        sides: 6,
      },
      threshold: 6,
    },
  },
];

export function validUnsignedPackage(): UnsignedSystemPackageV1 {
  return {
    schemaVersion: "1.0",
    systemId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    semanticVersion: "1.0.0",
    name: "Pocket Quest",
    description: "Original fixture",
    language: "en",
    defaultDice: "d20",
    entities: [
      {
        id: "character",
        label: "Character",
        fields: [
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
            elements: [{ kind: "field", id: "modifier_element", fieldId: "modifier" }],
          },
        ],
      },
    ],
    expressions: structuredClone(expressions),
    actions: [],
    validations: [],
    effectiveLimits: {
      expressionBytes: PACKAGE_LIMITS.expressionBytes,
      expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
      expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
      dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
      sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
    },
  };
}

export function validSignedShapePackage(): SystemPackageV1 {
  return {
    ...validUnsignedPackage(),
    integrity: { checksum: `sha256:${"0".repeat(64)}` },
  };
}
