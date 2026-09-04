import { describe, expect, it } from "vitest";
import { d20Document, d20Package, d6SuccessPoolDocument, d6SuccessPoolPackage, pbta2d6Document, pbta2d6Package } from "../package/fixtures/index.js";
import { compileDocument } from "./compile-document.js";

const opts = { systemId: "a0000000-0000-5000-8000-000000000001", versionId: "a0000000-0000-5000-8000-000000000002", semanticVersion: "1.0.0" };

describe("compileDocument", () => {
  it("reproduces the d20 package fixture", () => {
    const r = compileDocument(d20Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions).toHaveLength(3);
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
    expect(r.value.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(d20Package.expressions[i]!.ast);
    }
  });

  it("compiles the 2d6 document", () => {
    const r = compileDocument(pbta2d6Document, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 6, 7]);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(pbta2d6Package.expressions[i]!.ast);
    }
  });

  it("compiles the d6 pool document", () => {
    const r = compileDocument(d6SuccessPoolDocument, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expressions.map((e) => e.cost)).toEqual([3, 7, 7]);
    for (let i = 0; i < r.value.expressions.length; i++) {
      expect(r.value.expressions[i]!.ast).toEqual(d6SuccessPoolPackage.expressions[i]!.ast);
    }
  });

  it("rejects a document with an invalid expression", () => {
    const bad = structuredClone(d20Document);
    bad.expressions[0]!.source = "fields.nope + 1";
    const r = compileDocument(bad, opts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("missing_reference");
  });

  it("preserves the expression context in compiled expressions", () => {
    const result = compileDocument(d20Document, {
      systemId: "00000000-0000-4000-8000-000000000000",
      versionId: "00000000-0000-4000-8000-000000000001",
      semanticVersion: "1.0.0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("compilation failed");
    expect(result.value.expressions.map((e) => e.context)).toEqual(["computed", "roll", "validation"]);
  });
});
