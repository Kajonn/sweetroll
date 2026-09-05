import { describe, expect, it } from "vitest";

import { blankDocument, documentReducer, type SystemDocumentV1 } from "./documentReducer.js";

describe("documentReducer", () => {
  it("setMetadata replaces name + description", () => {
    const next = documentReducer(blankDocument(), {
      type: "setMetadata",
      patch: { name: "X", description: "y" },
    });
    expect(next.metadata.name).toBe("X");
    expect(next.metadata.description).toBe("y");
  });

  it("setMetadata preserves unspecified fields", () => {
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      metadata: { name: "Original", description: "d", language: "en", defaultDice: "d20" },
    };
    const next = documentReducer(initial, {
      type: "setMetadata",
      patch: { name: "Renamed" },
    });
    expect(next.metadata).toEqual({
      name: "Renamed",
      description: "d",
      language: "en",
      defaultDice: "d20",
    });
  });

  it("setMetadata leaves the rest of the document untouched", () => {
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      entities: [{ id: "character", label: "Character", fields: [] }],
    };
    const next = documentReducer(initial, {
      type: "setMetadata",
      patch: { name: "X" },
    });
    expect(next.entities).toEqual(initial.entities);
    expect(next).not.toBe(initial);
    expect(next.metadata).not.toBe(initial.metadata);
  });

  it("addEntity appends to entities", () => {
    const next = documentReducer(blankDocument(), {
      type: "addEntity",
      entity: { id: "character", label: "Character", fields: [] },
    });
    expect(next.entities).toHaveLength(1);
    expect(next.entities[0]?.id).toBe("character");
  });

  it("removeEntity drops the matching entity", () => {
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      entities: [
        { id: "character", label: "Character", fields: [] },
        { id: "npc", label: "NPC", fields: [] },
      ],
    };
    const next = documentReducer(initial, { type: "removeEntity", entityId: "npc" });
    expect(next.entities.map((e) => e.id)).toEqual(["character"]);
  });

  it("updateField replaces the matching field on the matching entity", () => {
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      entities: [
        {
          id: "character",
          label: "Character",
          fields: [
            { id: "name", label: "Name", kind: "text", default: "", required: true } as never,
            { id: "modifier", label: "Modifier", kind: "integer", default: 0 } as never,
          ],
        },
      ],
    };
    const updatedField = {
      id: "modifier",
      label: "Modifier",
      kind: "integer",
      default: 3,
    } as never;
    const next = documentReducer(initial, {
      type: "updateField",
      entityId: "character",
      fieldId: "modifier",
      field: updatedField,
    });
    expect(next.entities[0]?.fields[1]).toBe(updatedField);
    expect(next.entities[0]?.fields[0]).toBe(initial.entities[0]?.fields[0]);
  });

  it("blankDocument matches the SystemDocumentV1 defaults", () => {
    const doc = blankDocument();
    expect(doc.schemaVersion).toBe("1.0");
    expect(doc.metadata).toEqual({ name: "", description: "", language: "en", defaultDice: "d20" });
    expect(doc.entities).toEqual([]);
    expect(doc.referenceData).toEqual([]);
    expect(doc.sheets).toEqual([]);
    expect(doc.expressions).toEqual([]);
    expect(doc.actions).toEqual([]);
    expect(doc.validations).toEqual([]);
  });

  it("setSheets replaces the sheets collection", () => {
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      sheets: [
        {
          id: "main",
          label: "Main",
          targetEntityId: "character",
          sections: [],
        },
      ],
    };
    const next = documentReducer(initial, {
      type: "setSheets",
      sheets: [
        {
          id: "alt",
          label: "Alt",
          targetEntityId: "character",
          sections: [],
        },
      ],
    });
    expect(next.sheets.map((s) => s.id)).toEqual(["alt"]);
    expect(next).not.toBe(initial);
  });

  it("setActions replaces the actions collection", () => {
    const next = documentReducer(blankDocument(), {
      type: "setActions",
      actions: [
        {
          id: "atk",
          label: "Attack",
          kind: "roll",
          expressionId: "atk_expr",
          inputs: [],
          outputTemplate: "{total}",
        },
      ],
    });
    expect(next.actions.map((a) => a.id)).toEqual(["atk"]);
  });

  it("setValidations replaces the validations collection", () => {
    const next = documentReducer(blankDocument(), {
      type: "setValidations",
      validations: [
        {
          id: "warn_low_hp",
          expressionId: "low_hp",
          severity: "warning",
          message: "validation.characterHealthLow",
          targetId: "character",
        },
      ],
    });
    expect(next.validations.map((v) => v.id)).toEqual(["warn_low_hp"]);
  });

  it("setReferenceData replaces the referenceData collection", () => {
    const next = documentReducer(blankDocument(), {
      type: "setReferenceData",
      referenceData: [
        { id: "skills", label: "Skills", records: [] },
      ],
    });
    expect(next.referenceData.map((r) => r.id)).toEqual(["skills"]);
  });
});
