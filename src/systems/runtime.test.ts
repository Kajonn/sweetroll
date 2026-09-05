import type { Pool } from "pg";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { d20Package } from "./implementation/package/fixtures/index.js";
import type { SystemPackageV1 } from "./implementation/package/schema/index.js";
import {
  PublishedPackageCorruptError,
  createFixturePublishedPackageLoader,
  createPostgresPublishedPackageLoader,
  type PublishedPackageLoader,
} from "./implementation/runtime/package-loader.js";
import type {
  RuntimeErrorCode,
  RuntimeResolution,
  RuntimeResult,
  SystemRuntime,
} from "./runtime.js";

describe("SystemRuntime contract", () => {
  it("exposes the stable asynchronous resolution contract", () => {
    expectTypeOf<SystemRuntime["resolve"]>().returns.toEqualTypeOf<
      Promise<RuntimeResult<RuntimeResolution>>
    >();
    expectTypeOf<RuntimeErrorCode>().toEqualTypeOf<
      | "bad_request"
      | "not_found"
      | "invalid_package"
      | "invalid_state"
      | "unsupported_field_value"
      | "budget_exceeded"
      | "internal"
    >();
  });
});

describe("published package loaders", () => {
  it("loads fixture packages by exact version and returns null for absence", async () => {
    const loadPackage = createFixturePublishedPackageLoader([d20Package]);

    expect(await loadPackage(d20Package.versionId)).toEqual(d20Package);
    expect(await loadPackage("missing")).toBeNull();
  });

  it("decodes a package loaded from PostgreSQL", async () => {
    const pool = queryPool([{ package_json: d20Package, checksum: d20Package.integrity.checksum }]);
    const loadPackage = createPostgresPublishedPackageLoader(pool);

    const loaded = await loadPackage(d20Package.versionId);

    expectTypeOf(loadPackage).toEqualTypeOf<PublishedPackageLoader>();
    expect(loaded).toEqual(d20Package);
  });

  it("returns null when PostgreSQL has no matching version", async () => {
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([]));

    expect(await loadPackage("missing")).toBeNull();
  });

  it("throws typed corruption without package JSON for a malformed row", async () => {
    const malformedPackage = { versionId: d20Package.versionId, privateValue: "do-not-leak" };
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([
      { package_json: malformedPackage, checksum: d20Package.integrity.checksum },
    ]));

    const error = await captureCorruption(loadPackage, d20Package.versionId);

    expect(error).toMatchObject({
      code: "published_package_corrupt",
      versionId: d20Package.versionId,
    });
    expect(JSON.stringify(error)).not.toContain("do-not-leak");
  });

  it("throws typed corruption when the row checksum differs from the package", async () => {
    const rowChecksum = `sha256:${"0".repeat(64)}`;
    const loadPackage = createPostgresPublishedPackageLoader(queryPool([
      { package_json: d20Package, checksum: rowChecksum },
    ]));

    const error = await captureCorruption(loadPackage, d20Package.versionId);

    expect(error).toMatchObject({
      code: "published_package_corrupt",
      versionId: d20Package.versionId,
    });
    expect(JSON.stringify(error)).not.toContain(JSON.stringify(d20Package));
  });
});

function queryPool(rows: Array<{ package_json: unknown; checksum: string }>): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

async function captureCorruption(
  loadPackage: (versionId: string) => Promise<SystemPackageV1 | null>,
  versionId: string,
): Promise<PublishedPackageCorruptError> {
  try {
    await loadPackage(versionId);
  } catch (error) {
    expect(error).toBeInstanceOf(PublishedPackageCorruptError);
    return error as PublishedPackageCorruptError;
  }
  throw new Error("Expected published package corruption");
}
