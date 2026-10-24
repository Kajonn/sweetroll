import { describe, expect, it } from "vitest";
import { namedDicePoolDocument } from "./fixtures/named-dice-pool.js";
import { d6SuccessPoolPackage } from "./fixtures/d6-success-pool.js";
import { compileDocument } from "../rules/compile-document.js";
import {
  decodeSystemDocument,
  decodeSystemPackage,
  decodeSystemExport,
} from "./codec.js";
import { documentFromPackage } from "../authoring/assess.js";
import { signSystemPackage } from "./canonical.js";
const ids = {
  systemId: "10000000-0000-4000-8000-000000000001",
  versionId: "10000000-0000-4000-8000-000000000002",
  semanticVersion: "1.0.0",
};
describe("versioned named-group package round trips", () => {
  it("preserves source/version/checksum across import/export and clone", () => {
    const doc = namedDicePoolDocument();
    expect(decodeSystemDocument(doc).ok).toBe(true);
    const compiled = compileDocument(doc, ids);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const pkg = compiled.value;
    expect(pkg.schemaVersion).toBe("1.1");
    expect(decodeSystemPackage(pkg).ok).toBe(true);
    expect(documentFromPackage(pkg).expressions).toEqual(doc.expressions);
    expect(documentFromPackage(pkg).schemaVersion).toBe("1.1");
    const exported = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.system+json;version=1",
      exportedAt: "2026-10-23T00:00:00.000Z",
      package: pkg,
    };
    expect(decodeSystemExport(JSON.stringify(exported)).ok).toBe(true);
    const roundtrip = compileDocument(documentFromPackage(pkg), ids);
    expect(roundtrip.ok && roundtrip.value.integrity).toEqual(pkg.integrity);
  });
  it("rejects new features in old versions, unknown package/grammar and forged group metadata", () => {
    const doc = namedDicePoolDocument();
    doc.schemaVersion = "1.0";
    expect(compileDocument(doc, ids).ok).toBe(false);
    doc.schemaVersion = "1.1";
    const result = compileDocument(doc, ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const downgrade = structuredClone(result.value);
    downgrade.schemaVersion = "1.0";
    expect(decodeSystemPackage(signSystemPackage(downgrade)).ok).toBe(false);
    const unknown = { ...result.value, schemaVersion: "1.2" };
    expect(decodeSystemPackage(unknown).ok).toBe(false);
    const expr = result.value.expressions.find(
      (e) => e.id === "pool_roll_expr",
    )!;
    expect(
      decodeSystemPackage({
        ...result.value,
        expressions: [{ ...expr, languageVersion: "0.3" }],
      }).ok,
    ).toBe(false);
  });
  it("decodes legacy published packages without changing checksums or adding metadata", () => {
    const before = JSON.stringify(d6SuccessPoolPackage);
    expect(decodeSystemPackage(d6SuccessPoolPackage).ok).toBe(true);
    expect(JSON.stringify(d6SuccessPoolPackage)).toBe(before);
    expect(
      d6SuccessPoolPackage.expressions.every(
        (e) => e.languageVersion === undefined,
      ),
    ).toBe(true);
  });
});
