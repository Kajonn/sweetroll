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
});
