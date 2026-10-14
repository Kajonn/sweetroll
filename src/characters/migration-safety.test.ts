import { describe, expect, it, vi } from "vitest";
import { buildMigrationCandidate } from "./migration.js";
import type { SystemRuntime } from "../systems/runtime.js";

describe("entry migration safety", () => {
  it.each(["personal", "system"])(
    "rejects rebuilding a sheet containing %s entries before runtime initialization",
    async (kind) => {
      const resolve = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          state: { schemaVersion: "1.0", values: {}, entries: {} },
          projection: { sheets: [] },
        },
      });
      const result = await buildMigrationCandidate(
        {
          runtime: { resolve } as unknown as SystemRuntime,
          authorizeVersionUse: vi.fn().mockResolvedValue({
            ok: true,
            value: { systemId: "system", versionId: "target" },
          }),
          loadVersionIdentity: vi
            .fn()
            .mockResolvedValue({ systemId: "system", checksum: "old" }),
        },
        { actorId: "actor", requestId: "request" },
        {
          character: {
            characterId: "character",
            systemVersionId: "source",
            entityDefinitionId: "hero",
            revision: 2,
            state: {
              schemaVersion: "1.0",
              values: {},
              entries: {
                copy: {
                  entryId: "copy",
                  slotId: "inventory",
                  templateId: kind === "system" ? "sword" : null,
                  values: { name: "Key" },
                },
              },
            },
          },
          targetVersionId: "target",
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "conflict",
          message: expect.stringContaining("entries"),
        },
      });
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
