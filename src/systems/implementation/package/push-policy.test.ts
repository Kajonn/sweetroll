import { describe, expect, it } from "vitest";
import { namedDicePoolDocument } from "./fixtures/named-dice-pool.js";
import { compileDocument } from "../rules/compile-document.js";
import {
  decodeSystemDocument,
  decodeSystemExport,
  decodeSystemPackage,
} from "./codec.js";
import { documentFromPackage } from "../authoring/assess.js";
import { signSystemPackage } from "./canonical.js";
const ids = {
  systemId: "10000000-0000-4000-8000-000000000001",
  versionId: "10000000-0000-4000-8000-000000000002",
  semanticVersion: "1.0.0",
};
export function pushDocument() {
  const doc = namedDicePoolDocument();
  Object.assign(doc, { schemaVersion: "1.2" });
  Object.assign(doc.actions.find((a) => a.kind === "roll")!, {
    pushPolicy: {
      version: "1.0",
      maxAttempts: 2,
      successThreshold: 10,
      allowOnSuccess: true,
      groups: [
        { groupId: "attribute", lockedFaces: [1, 6], reportedFaces: [] },
        { groupId: "skill", lockedFaces: [8], reportedFaces: [] },
        { groupId: "gear", lockedFaces: [1], reportedFaces: [1] },
      ],
    },
  });
  return doc;
}
describe("versioned push policy", () => {
  it("round trips package 1.2 without a new grammar or loss of policy", () => {
    const doc = pushDocument();
    expect(decodeSystemDocument(doc).ok).toBe(true);
    const c = compileDocument(doc, ids);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.schemaVersion).toBe("1.2");
    expect(decodeSystemPackage(c.value).ok).toBe(true);
    const clone = documentFromPackage(c.value);
    expect(clone.actions).toEqual(doc.actions);
    expect(compileDocument(clone, ids)).toEqual(c);
    expect(
      decodeSystemExport({
        schemaVersion: "1.0",
        mediaType: "application/vnd.sweetroll.system+json;version=1",
        exportedAt: "2026-10-24T00:00:00Z",
        package: c.value,
      }).ok,
    ).toBe(true);
  });
  it.each(["1.0", "1.1"] as const)("rejects a push policy in %s", (v) => {
    const doc = pushDocument();
    doc.schemaVersion = v;
    expect(compileDocument(doc, ids).ok).toBe(false);
  });
  it.each(["duplicate", "unknown", "face", "attempt", "nonlinear", "keep"])(
    "rejects invalid %s policies",
    (kind) => {
      const doc = pushDocument();
      const a = doc.actions.find((a) => a.kind === "roll")!;
      const policy = (
        a as unknown as {
          pushPolicy: {
            groups: { groupId: string; lockedFaces: number[] }[];
            maxAttempts: number;
          };
        }
      ).pushPolicy;
      if (kind === "duplicate") policy.groups.push(policy.groups[0]!);
      if (kind === "unknown") policy.groups[0]!.groupId = "missing";
      if (kind === "face") policy.groups[0]!.lockedFaces = [7];
      if (kind === "attempt") policy.maxAttempts = 11;
      if (kind === "nonlinear")
        doc.expressions.find((e) => e.id === "pool_roll_expr")!.source =
          'group("attribute","Attribute",dice(3,6)) / group("skill","Skill",dice(2,8)) + group("gear","Gear",dice(1,4))';
      if (kind === "keep")
        doc.expressions.find((e) => e.id === "pool_roll_expr")!.source =
          'group("attribute","Attribute",3d6kh2) + group("skill","Skill",2d8) + group("gear","Gear",1d4)';
      expect(compileDocument(doc, ids).ok).toBe(false);
    },
  );
  it("rejects a signed package downgraded around its policy", () => {
    const c = compileDocument(pushDocument(), ids);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(
      decodeSystemPackage(
        signSystemPackage({ ...c.value, schemaVersion: "1.1" }),
      ).ok,
    ).toBe(false);
  });
});
