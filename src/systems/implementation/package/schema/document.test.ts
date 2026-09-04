import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { PACKAGE_LIMITS } from "../limits.js";
import { SystemDocumentV1Schema, type SystemDocumentV1 } from "./document.js";
import { validDocument } from "./test-values.js";

const validate = new Ajv({ allErrors: true, strict: true }).compile(SystemDocumentV1Schema);

describe("SystemDocumentV1Schema", () => {
  it("accepts the editable v1 document and every represented tagged variant", () => {
    expect(validate(validDocument())).toBe(true);
  });

  it.each([
    ["unknown root property", { ...validDocument(), extra: true }],
    [
      "unknown nested property",
      { ...validDocument(), metadata: { ...validDocument().metadata, extra: true } },
    ],
    ["bad schema version", { ...validDocument(), schemaVersion: "2.0" }],
    [
      "malformed definition id",
      {
        ...validDocument(),
        entities: [{ ...validDocument().entities[0]!, id: "Bad-ID" }],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(validate(value)).toBe(false);
  });

  it("rejects an expression over the byte ceiling", () => {
    const value = validDocument();
    value.expressions[0] = {
      ...value.expressions[0]!,
      source: "x".repeat(PACKAGE_LIMITS.expressionBytes + 1),
    };
    expect(validate(value)).toBe(false);
  });

  it("rejects malformed reference value keys", () => {
    const value = validDocument();
    const values = value.referenceData[0]!.records[0]!.values as Record<string, unknown>;
    values["Bad-Key"] = "invalid";

    expect(validate(value)).toBe(false);
  });

  const scalarStringLocations: Array<[
    string,
    (value: SystemDocumentV1, text: string) => void,
  ]> = [
    [
      "reference value",
      (value, text) => {
        value.referenceData[0]!.records[0]!.values.description = text;
      },
    ],
    [
      "expression fallback",
      (value, text) => {
        value.expressions[0]!.fallback = text;
      },
    ],
    [
      "action input default",
      (value, text) => {
        const action = value.actions[0];
        if (action?.kind !== "roll") throw new Error("Expected roll action fixture");
        action.inputs[0]!.default = text;
      },
    ],
  ];

  it.each(scalarStringLocations)("accepts a 10,000-character %s string", (_name, setValue) => {
    const value = validDocument();
    setValue(value, "x".repeat(10_000));

    expect(validate(value)).toBe(true);
  });

  it.each(scalarStringLocations)("rejects a %s string over 10,000 characters", (_name, setValue) => {
    const value = validDocument();
    setValue(value, "x".repeat(10_001));

    expect(validate(value)).toBe(false);
  });

  const collectionCeilings: Array<[
    string,
    number,
    (value: SystemDocumentV1, count: number) => void,
  ]> = [
    [
      "entities",
      PACKAGE_LIMITS.entities,
      (value, count) => {
        value.entities = Array.from({ length: count }, () => value.entities[0]!);
      },
    ],
    [
      "reference records",
      PACKAGE_LIMITS.referenceRecordsPerSet,
      (value, count) => {
        const referenceData = value.referenceData[0]!;
        referenceData.records = Array.from({ length: count }, () => referenceData.records[0]!);
      },
    ],
    [
      "sheet sections",
      PACKAGE_LIMITS.sectionsPerSheet,
      (value, count) => {
        const sheet = value.sheets[0]!;
        sheet.sections = Array.from({ length: count }, () => sheet.sections[0]!);
      },
    ],
  ];

  it.each(collectionCeilings)("enforces the %s collection ceiling", (_name, limit, setCount) => {
    const boundary = validDocument();
    setCount(boundary, limit);
    expect(validate(boundary)).toBe(true);

    const overLimit = validDocument();
    setCount(overLimit, limit + 1);
    expect(validate(overLimit)).toBe(false);
  });
});
