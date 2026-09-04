import { describe, expect, it } from "vitest";

import { decodeSystemDocument } from "../package/codec.js";
import {
  d20Document,
  d20Package,
  d6SuccessPoolDocument,
  pbta2d6Document,
} from "../package/fixtures/index.js";
import { compileDocument } from "../rules/compile-document.js";
import {
  assessDocument,
  blankSystemDocument,
  documentChecksum,
  documentFromPackage,
  hashInput,
} from "./assess.js";

describe("assessment helpers", () => {
  it("creates a blank document that decodes and assesses cleanly", () => {
    const blank = blankSystemDocument("My System");
    expect(decodeSystemDocument(blank).ok).toBe(true);
    expect(blank.metadata.name).toBe("My System");
    const assessed = assessDocument(blank);
    expect(assessed.ok).toBe(true);
  });

  it.each([
    ["d20", d20Document],
    ["2d6", pbta2d6Document],
    ["d6 success pool", d6SuccessPoolDocument],
  ])("assesses the %s reference document as ok with no diagnostics", (_name, document) => {
    const assessed = assessDocument(document);
    expect(assessed.ok).toBe(true);
    expect(assessed.assessment).toEqual({ ok: true, diagnostics: [] });
  });

  it("reports diagnostics for structurally invalid input without a document", () => {
    const assessed = assessDocument({ nope: true });
    expect(assessed.ok).toBe(false);
    expect(assessed.document).toBeNull();
    expect(assessed.assessment.ok).toBe(false);
    expect(assessed.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps a structurally safe document when expressions fail to compile", () => {
    const broken = blankSystemDocument("Broken");
    broken.entities.push({
      id: "character",
      label: "Character",
      fields: [
        { kind: "text", id: "name", label: "Name", default: "", required: true, minLength: 1, maxLength: 120 },
      ],
    });
    broken.expressions.push({
      id: "broken_expr",
      context: "computed",
      resultType: "number",
      source: "fields.missing_field + 1",
      fallback: 0,
    });
    const assessed = assessDocument(broken);
    expect(assessed.ok).toBe(false);
    expect(assessed.document).not.toBeNull();
    expect(assessed.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("reconstructs a document from a package that recompiles to the same checksum", () => {
    const document = documentFromPackage(d20Package);
    const compiled = compileDocument(document, {
      systemId: d20Package.systemId,
      versionId: d20Package.versionId,
      semanticVersion: d20Package.semanticVersion,
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.integrity.checksum).toBe(d20Package.integrity.checksum);
    }
  });

  it("produces stable sha256 checksums for documents and inputs", () => {
    expect(documentChecksum(d20Document)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(documentChecksum(d20Document)).toBe(documentChecksum(structuredClone(d20Document)));
    expect(hashInput({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  });
});
