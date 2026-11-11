import { describe, expect, it } from "vitest";

import { decodeSystemDocument, decodeSystemPackage } from "../codec.js";
import { d20Document, d20Package } from "../fixtures/d20.js";

describe("current system rules contract", () => {
  it("authors and publishes a single document and package version with grammar 1.0", () => {
    expect(d20Document.schemaVersion).toBe("2.0");
    expect(d20Package.schemaVersion).toBe("2.0");
    expect(d20Package.expressions.every(expression => expression.languageVersion === "1.0")).toBe(true);
    expect(decodeSystemDocument(d20Document).ok).toBe(true);
    expect(decodeSystemPackage(d20Package).ok).toBe(true);
  });

  it("requires explicit template and slot collections", () => {
    const { templates, ...missingTemplates } = d20Document;
    const { slots, ...missingSlots } = d20Package;
    expect(decodeSystemDocument(missingTemplates).ok).toBe(false);
    expect(decodeSystemPackage(missingSlots).ok).toBe(false);
  });
});
