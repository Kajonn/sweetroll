import { describe, expect, it } from "vitest";

import {
  d20Package,
  d6SuccessPoolPackage,
  pbta2d6Package,
} from "../../../src/systems/implementation/package/fixtures/index.js";
import type { SystemPackageV1 } from "../../../src/systems/implementation/package/schema/index.js";

import { generateSample, type EntityDefinitionV1 } from "./sampleData.js";

function asPackage(pkg: unknown): SystemPackageV1 {
  return pkg as SystemPackageV1;
}

describe("generateSample", () => {
  describe("determinism", () => {
    it("returns identical output across calls for the d20 fixture", () => {
      const a = generateSample(asPackage(d20Package));
      const b = generateSample(asPackage(d20Package));
      expect(b).toEqual(a);
    });

    it("returns identical output across calls for the PbtA fixture", () => {
      const a = generateSample(asPackage(pbta2d6Package));
      const b = generateSample(asPackage(pbta2d6Package));
      expect(b).toEqual(a);
    });

    it("returns identical output across calls for the counted-success fixture", () => {
      const a = generateSample(asPackage(d6SuccessPoolPackage));
      const b = generateSample(asPackage(d6SuccessPoolPackage));
      expect(b).toEqual(a);
    });
  });

  describe("d20 fixture", () => {
    it("produces one record per entity type", () => {
      const sample = generateSample(asPackage(d20Package));
      expect(Object.keys(sample)).toEqual(["character"]);
    });

    it("sets scalar fields to their declared defaults", () => {
      const sample = generateSample(asPackage(d20Package));
      const fields = sample.character?.fields;
      expect(fields?.ability).toBe(10);
      expect(fields?.modifier).toBe(0);
    });

    it("sets booleans to false (not the declared default)", () => {
      const sample = generateSample(asPackage(d20Package));
      expect(sample.character?.fields.proficient).toBe(false);
    });

    it("sets singleChoice fields to the first option id", () => {
      const sample = generateSample(asPackage(d20Package));
      expect(sample.character?.fields.ancestry).toBe("human");
    });

    it("sets resource fields to current = max (the field's upper bound)", () => {
      const sample = generateSample(asPackage(d20Package));
      expect(sample.character?.fields.health).toEqual({ current: 30, max: 30 });
    });

    it("evaluates the defense computed field against the sample bindings", () => {
      const sample = generateSample(asPackage(d20Package));
      expect(sample.character?.fields.defense).toBe(10);
    });
  });

  describe("PbtA fixture", () => {
    it("sets scalar fields to their declared defaults", () => {
      const sample = generateSample(asPackage(pbta2d6Package));
      const fields = sample.character?.fields;
      expect(fields?.move_stat).toBe(0);
      expect(fields?.description).toBe("");
    });

    it("sets booleans to false", () => {
      const sample = generateSample(asPackage(pbta2d6Package));
      expect(sample.character?.fields.condition).toBe(false);
    });

    it("sets singleChoice fields to the first option id", () => {
      const sample = generateSample(asPackage(pbta2d6Package));
      expect(sample.character?.fields.playbook).toBe("fighter");
    });

    it("sets resource fields to current = max", () => {
      const sample = generateSample(asPackage(pbta2d6Package));
      expect(sample.character?.fields.harm).toEqual({ current: 7, max: 7 });
    });

    it("evaluates current_penalty against the resource current value", () => {
      const sample = generateSample(asPackage(pbta2d6Package));
      expect(sample.character?.fields.current_penalty).toBe(3);
    });
  });

  describe("d6 success-pool fixture", () => {
    it("sets scalar fields to their declared defaults", () => {
      const sample = generateSample(asPackage(d6SuccessPoolPackage));
      const fields = sample.character?.fields;
      expect(fields?.attribute).toBe(1);
      expect(fields?.skill).toBe(1);
    });

    it("sets singleChoice fields to the first option id", () => {
      const sample = generateSample(asPackage(d6SuccessPoolPackage));
      expect(sample.character?.fields.specialty).toBe("combatant");
      expect(sample.character?.fields.condition).toBe("focused");
    });

    it("sets resource fields to current = max", () => {
      const sample = generateSample(asPackage(d6SuccessPoolPackage));
      expect(sample.character?.fields.stress).toEqual({ current: 10, max: 10 });
    });

    it("evaluates pool_size from attribute + skill", () => {
      const sample = generateSample(asPackage(d6SuccessPoolPackage));
      expect(sample.character?.fields.pool_size).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("sets multiChoice fields to a single-element array with the first option id", () => {
      const entity: EntityDefinitionV1 = {
        id: "character",
        label: "Character",
        fields: [
          {
            kind: "multiChoice",
            id: "tags",
            label: "Tags",
            required: false,
            default: [],
            options: [
              { id: "alpha", label: "Alpha" },
              { id: "beta", label: "Beta" },
            ],
          },
        ],
      };
      const sample = generateSample(asPackage({ entities: [entity], expressions: [] }));
      expect(sample.character?.fields.tags).toEqual(["alpha"]);
    });

    it("returns an empty multiChoice array when the field has no options", () => {
      const entity: EntityDefinitionV1 = {
        id: "character",
        label: "Character",
        fields: [
          {
            kind: "multiChoice",
            id: "tags",
            label: "Tags",
            required: false,
            default: [],
            options: [],
          },
        ],
      };
      const sample = generateSample(asPackage({ entities: [entity], expressions: [] }));
      expect(sample.character?.fields.tags).toEqual([]);
    });

    it("returns null for a singleChoice field with no options", () => {
      const entity: EntityDefinitionV1 = {
        id: "character",
        label: "Character",
        fields: [
          {
            kind: "singleChoice",
            id: "ancestry",
            label: "Ancestry",
            required: false,
            default: null,
            options: [],
          },
        ],
      };
      const sample = generateSample(asPackage({ entities: [entity], expressions: [] }));
      expect(sample.character?.fields.ancestry).toBeNull();
    });

    it("returns null when the computed field references an unknown expression", () => {
      const entity: EntityDefinitionV1 = {
        id: "character",
        label: "Character",
        fields: [
          { kind: "integer", id: "x", label: "X", default: 5, required: false, min: 0, max: 10, step: 1 },
          {
            kind: "computed",
            id: "broken",
            label: "Broken",
            valueType: "number",
            expressionId: "missing_expr",
          },
        ],
      };
      const sample = generateSample(asPackage({ entities: [entity], expressions: [] }));
      expect(sample.character?.fields.broken).toBeNull();
    });
  });
});
