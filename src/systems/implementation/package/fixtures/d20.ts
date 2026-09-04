import { signSystemPackage } from "../canonical.js";
import { PACKAGE_LIMITS } from "../limits.js";
import type { SystemDocumentV1 } from "../schema/document.js";
import type { SystemExportV1 } from "../schema/export.js";
import type { SystemPackageV1, UnsignedSystemPackageV1 } from "../schema/package.js";

export const d20Document: SystemDocumentV1 = {
  schemaVersion: "1.0",
  metadata: {
    name: "D20 System",
    description: "Classic d20-based fantasy system",
    language: "en",
    defaultDice: "d20",
  },
  entities: [
    {
      id: "character",
      label: "Character",
      fields: [
        {
          kind: "integer",
          id: "ability",
          label: "Ability Score",
          default: 10,
          required: true,
          min: 3,
          max: 18,
          step: 1,
        },
        {
          kind: "integer",
          id: "modifier",
          label: "Modifier",
          default: 0,
          required: true,
          min: -5,
          max: 10,
          step: 1,
        },
        {
          kind: "boolean",
          id: "proficient",
          label: "Proficient",
          default: false,
          required: true,
        },
        {
          kind: "singleChoice",
          id: "ancestry",
          label: "Ancestry",
          required: false,
          default: null,
          options: [
            { id: "human", label: "Human" },
            { id: "elf", label: "Elf" },
            { id: "dwarf", label: "Dwarf" },
          ],
        },
        {
          kind: "resource",
          id: "health",
          label: "Health",
          default: { current: 10, max: 10 },
          min: 0,
          max: 30,
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
          id: "basics",
          label: "Basics",
          elements: [
            { kind: "heading", id: "basics_heading", text: "Basics", level: 2 },
            { kind: "field", id: "ancestry_element", fieldId: "ancestry" },
          ],
        },
        {
          id: "abilities",
          label: "Abilities",
          elements: [
            { kind: "heading", id: "abilities_heading", text: "Abilities", level: 2 },
            { kind: "field", id: "ability_element", fieldId: "ability" },
            { kind: "field", id: "modifier_element", fieldId: "modifier" },
            { kind: "field", id: "defense_element", fieldId: "defense" },
          ],
        },
        {
          id: "combat",
          label: "Combat",
          elements: [
            { kind: "heading", id: "combat_heading", text: "Combat", level: 2 },
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
      id: "check_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.modifier + inputs.bonus",
      fallback: 0,
    },
    {
      id: "ability_valid_expr",
      context: "validation",
      resultType: "boolean",
      source: "fields.ability >= 3 && fields.ability <= 18",
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
          label: "Situational Bonus",
          valueType: "integer",
          required: false,
          default: 0,
        },
      ],
      outputTemplate: "Result: {total}",
    },
    {
      kind: "resourceBump",
      id: "damage",
      label: "Damage",
      resourceId: "health",
      operation: { kind: "delta", amount: -1 },
    },
    {
      kind: "resourceBump",
      id: "heal",
      label: "Heal",
      resourceId: "health",
      operation: { kind: "delta", amount: 1 },
    },
  ],
  validations: [
    {
      id: "ability_valid",
      expressionId: "ability_valid_expr",
      severity: "error",
      message: "Ability score must be between 3 and 18",
      targetId: "ability",
    },
  ],
};

const unsignedPackage: UnsignedSystemPackageV1 = {
  schemaVersion: "1.0",
  systemId: "a0000000-0000-5000-8000-000000000001",
  versionId: "a0000000-0000-5000-8000-000000000002",
  semanticVersion: "1.0.0",
  name: "D20 System",
  description: "Classic d20-based fantasy system",
  language: "en",
  defaultDice: "d20",
  entities: [
    {
      id: "character",
      label: "Character",
      fields: [
        {
          kind: "integer",
          id: "ability",
          label: "Ability Score",
          default: 10,
          required: true,
          min: 3,
          max: 18,
          step: 1,
        },
        {
          kind: "integer",
          id: "modifier",
          label: "Modifier",
          default: 0,
          required: true,
          min: -5,
          max: 10,
          step: 1,
        },
        {
          kind: "boolean",
          id: "proficient",
          label: "Proficient",
          default: false,
          required: true,
        },
        {
          kind: "singleChoice",
          id: "ancestry",
          label: "Ancestry",
          required: false,
          default: null,
          options: [
            { id: "human", label: "Human" },
            { id: "elf", label: "Elf" },
            { id: "dwarf", label: "Dwarf" },
          ],
        },
        {
          kind: "resource",
          id: "health",
          label: "Health",
          default: { current: 10, max: 10 },
          min: 0,
          max: 30,
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
          id: "basics",
          label: "Basics",
          elements: [
            { kind: "heading", id: "basics_heading", text: "Basics", level: 2 },
            { kind: "field", id: "ancestry_element", fieldId: "ancestry" },
          ],
        },
        {
          id: "abilities",
          label: "Abilities",
          elements: [
            { kind: "heading", id: "abilities_heading", text: "Abilities", level: 2 },
            { kind: "field", id: "ability_element", fieldId: "ability" },
            { kind: "field", id: "modifier_element", fieldId: "modifier" },
            { kind: "field", id: "defense_element", fieldId: "defense" },
          ],
        },
        {
          id: "combat",
          label: "Combat",
          elements: [
            { kind: "heading", id: "combat_heading", text: "Combat", level: 2 },
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
      inferredType: "number",
      fallback: 10,
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
      id: "check_expr",
      context: "roll",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: ["bonus", "modifier"],
      cost: 6,
      ast: {
        kind: "binary",
        operator: "+",
        left: {
          kind: "binary",
          operator: "+",
          left: { kind: "dice", count: { kind: "numberLiteral", value: 1 }, sides: 20 },
          right: { kind: "reference", scope: "fields", id: "modifier" },
        },
        right: { kind: "reference", scope: "inputs", id: "bonus" },
      },
    },
    {
      id: "ability_valid_expr",
      context: "validation",
      resultType: "boolean",
      inferredType: "boolean",
      fallback: false,
      dependencies: ["ability"],
      cost: 7,
      ast: {
        kind: "binary",
        operator: "&&",
        left: {
          kind: "binary",
          operator: ">=",
          left: { kind: "reference", scope: "fields", id: "ability" },
          right: { kind: "numberLiteral", value: 3 },
        },
        right: {
          kind: "binary",
          operator: "<=",
          left: { kind: "reference", scope: "fields", id: "ability" },
          right: { kind: "numberLiteral", value: 18 },
        },
      },
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
          label: "Situational Bonus",
          valueType: "integer",
          required: false,
          default: 0,
        },
      ],
      outputTemplate: "Result: {total}",
    },
    {
      kind: "resourceBump",
      id: "damage",
      label: "Damage",
      resourceId: "health",
      operation: { kind: "delta", amount: -1 },
    },
    {
      kind: "resourceBump",
      id: "heal",
      label: "Heal",
      resourceId: "health",
      operation: { kind: "delta", amount: 1 },
    },
  ],
  validations: [
    {
      id: "ability_valid",
      expressionId: "ability_valid_expr",
      severity: "error",
      message: "Ability score must be between 3 and 18",
      targetId: "ability",
    },
  ],
  effectiveLimits: {
    expressionBytes: PACKAGE_LIMITS.expressionBytes,
    expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
    expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
    dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
    sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
  },
};

export const d20Package: SystemPackageV1 = signSystemPackage(unsignedPackage);

export const d20Export: SystemExportV1 = {
  schemaVersion: "1.0",
  mediaType: "application/vnd.sweetroll.system+json;version=1",
  exportedAt: "2026-09-04T12:00:00Z",
  package: d20Package,
};
