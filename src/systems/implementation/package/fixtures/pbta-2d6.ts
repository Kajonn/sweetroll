import { signSystemPackage } from "../canonical.js";
import { PACKAGE_LIMITS } from "../limits.js";
import type { SystemDocumentV1 } from "../schema/document.js";
import type { SystemPackageV1, UnsignedSystemPackageV1 } from "../schema/package.js";

export const pbta2d6Document: SystemDocumentV1 = {
  schemaVersion: "1.0",
  metadata: {
    name: "2d6 PbtA-style",
    description: "Powered by the Apocalypse style 2d6 system",
    language: "en",
    defaultDice: "2d6",
  },
  entities: [
    {
      id: "character",
      label: "Character",
      fields: [
        {
          kind: "integer",
          id: "move_stat",
          label: "Move Stat",
          default: 0,
          required: true,
          min: -1,
          max: 3,
          step: 1,
        },
        {
          kind: "text",
          id: "description",
          label: "Description",
          default: "",
          required: false,
          minLength: 0,
          maxLength: 500,
        },
        {
          kind: "singleChoice",
          id: "playbook",
          label: "Playbook",
          required: false,
          default: null,
          options: [
            { id: "fighter", label: "Fighter" },
            { id: "wizard", label: "Wizard" },
            { id: "thief", label: "Thief" },
          ],
        },
        {
          kind: "boolean",
          id: "condition",
          label: "Condition",
          default: false,
          required: true,
        },
        {
          kind: "resource",
          id: "harm",
          label: "Harm",
          default: { current: 0, max: 7 },
          min: 0,
          max: 7,
          step: 1,
          resetTo: "min",
        },
        {
          kind: "computed",
          id: "current_penalty",
          label: "Current Penalty",
          valueType: "number",
          expressionId: "penalty_expr",
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
          id: "stats",
          label: "Stats",
          elements: [
            { kind: "heading", id: "stats_heading", text: "Stats", level: 2 },
            { kind: "field", id: "move_stat_element", fieldId: "move_stat" },
            { kind: "field", id: "description_element", fieldId: "description" },
            { kind: "field", id: "playbook_element", fieldId: "playbook" },
            { kind: "field", id: "condition_element", fieldId: "condition" },
            { kind: "resource", id: "harm_element", resourceId: "harm" },
            { kind: "action", id: "make_move_element", actionId: "make_move" },
          ],
        },
      ],
    },
  ],
  expressions: [
    {
      id: "penalty_expr",
      context: "computed",
      resultType: "number",
      source: "min(fields.harm, 3)",
      fallback: 0,
    },
    {
      id: "move_expr",
      context: "roll",
      resultType: "number",
      source: "2d6 + fields.move_stat + inputs.forward",
      fallback: 0,
    },
    {
      id: "stat_valid_expr",
      context: "validation",
      resultType: "boolean",
      source: "fields.move_stat >= -1 && fields.move_stat <= 3",
      fallback: false,
    },
  ],
  actions: [
    {
      kind: "roll",
      id: "make_move",
      label: "Make Move",
      expressionId: "move_expr",
      inputs: [
        {
          id: "forward",
          label: "Forward Modifier",
          valueType: "integer",
          required: false,
          default: 0,
        },
      ],
      outputTemplate: "Result: {total}",
    },
    {
      kind: "resourceBump",
      id: "mark_harm",
      label: "Mark Harm",
      resourceId: "harm",
      operation: { kind: "delta", amount: 1 },
    },
  ],
  validations: [
    {
      id: "stat_valid",
      expressionId: "stat_valid_expr",
      severity: "error",
      message: "Move stat must be between -1 and 3",
      targetId: "move_stat",
    },
  ],
};

const unsignedPackage: UnsignedSystemPackageV1 = {
  schemaVersion: "1.0",
  systemId: "b0000000-0000-5000-8000-000000000001",
  versionId: "b0000000-0000-5000-8000-000000000002",
  semanticVersion: "1.0.0",
  name: "2d6 PbtA-style",
  description: "Powered by the Apocalypse style 2d6 system",
  language: "en",
  defaultDice: "2d6",
  entities: [
    {
      id: "character",
      label: "Character",
      fields: [
        {
          kind: "integer",
          id: "move_stat",
          label: "Move Stat",
          default: 0,
          required: true,
          min: -1,
          max: 3,
          step: 1,
        },
        {
          kind: "text",
          id: "description",
          label: "Description",
          default: "",
          required: false,
          minLength: 0,
          maxLength: 500,
        },
        {
          kind: "singleChoice",
          id: "playbook",
          label: "Playbook",
          required: false,
          default: null,
          options: [
            { id: "fighter", label: "Fighter" },
            { id: "wizard", label: "Wizard" },
            { id: "thief", label: "Thief" },
          ],
        },
        {
          kind: "boolean",
          id: "condition",
          label: "Condition",
          default: false,
          required: true,
        },
        {
          kind: "resource",
          id: "harm",
          label: "Harm",
          default: { current: 0, max: 7 },
          min: 0,
          max: 7,
          step: 1,
          resetTo: "min",
        },
        {
          kind: "computed",
          id: "current_penalty",
          label: "Current Penalty",
          valueType: "number",
          expressionId: "penalty_expr",
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
          id: "stats",
          label: "Stats",
          elements: [
            { kind: "heading", id: "stats_heading", text: "Stats", level: 2 },
            { kind: "field", id: "move_stat_element", fieldId: "move_stat" },
            { kind: "field", id: "description_element", fieldId: "description" },
            { kind: "field", id: "playbook_element", fieldId: "playbook" },
            { kind: "field", id: "condition_element", fieldId: "condition" },
            { kind: "resource", id: "harm_element", resourceId: "harm" },
            { kind: "action", id: "make_move_element", actionId: "make_move" },
          ],
        },
      ],
    },
  ],
  expressions: [
    {
      id: "penalty_expr",
      context: "computed",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: ["harm"],
      cost: 3,
      ast: {
        kind: "call",
        function: "min",
        arguments: [
          { kind: "reference", scope: "fields", id: "harm" },
          { kind: "numberLiteral", value: 3 },
        ],
      },
    },
    {
      id: "move_expr",
      context: "roll",
      resultType: "number",
      inferredType: "number",
      fallback: 0,
      dependencies: ["move_stat", "forward"],
      cost: 6,
      ast: {
        kind: "binary",
        operator: "+",
        left: {
          kind: "binary",
          operator: "+",
          left: { kind: "dice", count: { kind: "numberLiteral", value: 2 }, sides: 6 },
          right: { kind: "reference", scope: "fields", id: "move_stat" },
        },
        right: { kind: "reference", scope: "inputs", id: "forward" },
      },
    },
    {
      id: "stat_valid_expr",
      context: "validation",
      resultType: "boolean",
      inferredType: "boolean",
      fallback: false,
      dependencies: ["move_stat"],
      cost: 7,
      ast: {
        kind: "binary",
        operator: "&&",
        left: {
          kind: "binary",
          operator: ">=",
          left: { kind: "reference", scope: "fields", id: "move_stat" },
          right: { kind: "numberLiteral", value: -1 },
        },
        right: {
          kind: "binary",
          operator: "<=",
          left: { kind: "reference", scope: "fields", id: "move_stat" },
          right: { kind: "numberLiteral", value: 3 },
        },
      },
    },
  ],
  actions: [
    {
      kind: "roll",
      id: "make_move",
      label: "Make Move",
      expressionId: "move_expr",
      inputs: [
        {
          id: "forward",
          label: "Forward Modifier",
          valueType: "integer",
          required: false,
          default: 0,
        },
      ],
      outputTemplate: "Result: {total}",
    },
    {
      kind: "resourceBump",
      id: "mark_harm",
      label: "Mark Harm",
      resourceId: "harm",
      operation: { kind: "delta", amount: 1 },
    },
  ],
  validations: [
    {
      id: "stat_valid",
      expressionId: "stat_valid_expr",
      severity: "error",
      message: "Move stat must be between -1 and 3",
      targetId: "move_stat",
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

export const pbta2d6Package: SystemPackageV1 = signSystemPackage(unsignedPackage);
