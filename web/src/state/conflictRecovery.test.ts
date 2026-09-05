import { describe, expect, it } from "vitest";

import {
  buildAcceptTheirsPayload,
  buildKeepMinePayload,
  buildMergeIntoServerPayload,
  type ConflictPayload,
} from "./conflictRecovery.js";

describe("conflictRecovery", () => {
  describe("buildAcceptTheirsPayload", () => {
    it("returns a theirs-kind payload referencing the incoming document", () => {
      const theirs = { metadata: { name: "Server Wins" } };
      const payload = buildAcceptTheirsPayload(theirs);
      expect(payload).toEqual<ConflictPayload>({ kind: "theirs", document: theirs });
    });

    it("preserves the exact document reference (no defensive clone)", () => {
      const theirs = { metadata: { name: "Server" } };
      const payload = buildAcceptTheirsPayload(theirs);
      expect(payload.document).toBe(theirs);
    });
  });

  describe("buildKeepMinePayload", () => {
    it("returns a force-kind payload with expectedRevision: null", () => {
      const mine = { metadata: { name: "Local Wins" } };
      const payload = buildKeepMinePayload(mine);
      expect(payload).toEqual<ConflictPayload>({
        kind: "force",
        document: mine,
        expectedRevision: null,
      });
    });
  });

  describe("buildMergeIntoServerPayload", () => {
    it("returns a merge-kind payload with the supplied latestRevision", () => {
      const mine = { metadata: { name: "Merged" } };
      const payload = buildMergeIntoServerPayload(mine, 7);
      expect(payload).toEqual<ConflictPayload>({
        kind: "merge",
        document: mine,
        expectedRevision: 7,
      });
    });

    it("preserves the latestRevision unchanged when used with different revisions", () => {
      const mine = { metadata: { name: "Merged" } };
      const a = buildMergeIntoServerPayload(mine, 0);
      const b = buildMergeIntoServerPayload(mine, 42);
      const c = buildMergeIntoServerPayload(mine, 999);
      expect(a.kind).toBe("merge");
      expect(b.kind).toBe("merge");
      expect(c.kind).toBe("merge");
      if (a.kind === "merge") expect(a.expectedRevision).toBe(0);
      if (b.kind === "merge") expect(b.expectedRevision).toBe(42);
      if (c.kind === "merge") expect(c.expectedRevision).toBe(999);
    });
  });
});
