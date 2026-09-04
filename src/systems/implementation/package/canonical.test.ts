import { describe, expect, it } from "vitest";

import { calculatePackageChecksum, canonicalizePackage, signSystemPackage } from "./canonical.js";
import { decodeSystemExport, decodeSystemPackage } from "./codec.js";
import {
  validSignedPackage,
  validUnsignedPackage,
} from "./schema/test-values.js";

describe("canonical package serialization", () => {
  it("signs an unsigned package with a valid sha256 checksum", () => {
    const signed = signSystemPackage(validUnsignedPackage());
    expect(signed.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calculatePackageChecksum(signed)).toBe(signed.integrity.checksum);
  });

  it("produces identical canonical input when field order changes", () => {
    const signed = signSystemPackage(validUnsignedPackage());
    const reordered = {
      ...signed,
      language: "en",
      name: signed.name,
      description: signed.description,
      defaultDice: signed.defaultDice,
      semanticVersion: signed.semanticVersion,
      versionId: signed.versionId,
      systemId: signed.systemId,
    };
    expect(calculatePackageChecksum(reordered)).toBe(signed.integrity.checksum);
  });

  it("does not mutate the unsigned input when signing", () => {
    const unsigned = validUnsignedPackage();
    const before = JSON.stringify(unsigned);
    signSystemPackage(unsigned);
    expect(JSON.stringify(unsigned)).toBe(before);
  });

  it("changes checksum when a nested value is modified", () => {
    const signed = signSystemPackage(validUnsignedPackage());
    const extraSheet = {
      id: "second_sheet",
      label: "Second",
      targetEntityId: "character",
      sections: [
        {
          id: "alt",
          label: "Alt",
          elements: [{ kind: "field" as const, id: "alt_modifier_element", fieldId: "modifier" }],
        },
      ],
    };
    const tampered = { ...signed, sheets: [...signed.sheets, extraSheet].toReversed() };
    expect(calculatePackageChecksum(tampered)).not.toBe(signed.integrity.checksum);
  });

  it("accepts a signed package via decodeSystemPackage", () => {
    const signed = validSignedPackage();
    const result = decodeSystemPackage(signed);
    expect(result).toEqual({ ok: true, value: signed });
  });

  it("rejects a tampered package with checksum_mismatch", () => {
    const signed = validSignedPackage();
    const tampered = { ...signed, integrity: { checksum: `sha256:${"a".repeat(64)}` } };
    const result = decodeSystemPackage(tampered);
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        { code: "checksum_mismatch", path: "/integrity/checksum", message: "Package checksum does not match." },
      ],
    });
  });

  it("rejects a tampered export with /package prefixed checksum_mismatch", () => {
    const signed = validSignedPackage();
    const tampered = { ...signed, integrity: { checksum: `sha256:${"b".repeat(64)}` } };
    const exportValue = {
      schemaVersion: "1.0" as const,
      mediaType: "application/vnd.sweetroll.system+json;version=1" as const,
      exportedAt: "2026-09-04T12:00:00Z",
      package: tampered,
    };
    const result = decodeSystemExport(exportValue);
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        { code: "checksum_mismatch", path: "/package/integrity/checksum", message: "Package checksum does not match." },
      ],
    });
  });

  it("returns stable canonical output for identical unsigned data", () => {
    const first = canonicalizePackage(validUnsignedPackage());
    const second = canonicalizePackage(validUnsignedPackage());
    expect(first).toBe(second);
  });

  it("canonical input omits integrity and includes an empty object for it", () => {
    const unsigned = validUnsignedPackage();
    const signed = signSystemPackage(unsigned);
    const canonical = canonicalizePackage(signed);
    expect(canonical).toContain('"integrity":{}');
  });
});
