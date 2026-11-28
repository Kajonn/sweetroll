import type { Pool, PoolClient } from "pg";

import type { VersionId } from "../../runtime.js";
import { decodeSystemPackage } from "../package/codec.js";
import { decodeExtensionPackage } from "../package/extension.js";
import type { ExtensionPackageV1, SystemPackageV1 } from "../package/schema/index.js";

export type PublishedPackageLoader = (
  versionId: VersionId,
  transaction?: PoolClient,
) => Promise<SystemPackageV1 | null>;

export class PublishedPackageCorruptError extends Error {
  readonly code = "published_package_corrupt";

  constructor(readonly versionId: VersionId) {
    super(`Published package ${versionId} is corrupt.`);
    this.name = "PublishedPackageCorruptError";
  }
}

type PublishedPackageRow = {
  package_json: unknown;
  checksum: string;
};

export function createPostgresPublishedPackageLoader(
  pool: Pool,
): PublishedPackageLoader {
  return async (versionId, transaction) => {
    const result = await (transaction ?? pool).query<PublishedPackageRow>(
      `SELECT package_json, checksum
         FROM system_versions
        WHERE id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    return decodePublishedPackage(versionId, row.package_json, row.checksum);
  };
}

export function createFixturePublishedPackageLoader(
  packages: readonly SystemPackageV1[],
): PublishedPackageLoader {
  return async (versionId) => {
    const packageValue = packages.find(
      (candidate) => candidate.versionId === versionId,
    );
    if (packageValue === undefined) return null;

    return decodePublishedPackage(
      versionId,
      packageValue,
      packageValue.integrity.checksum,
    );
  };
}

function decodePublishedPackage(
  versionId: VersionId,
  packageJson: unknown,
  rowChecksum: string,
): SystemPackageV1 {
  const decoded = decodeSystemPackage(packageJson);
  if (!decoded.ok || decoded.value.integrity.checksum !== rowChecksum) {
    throw new PublishedPackageCorruptError(versionId);
  }
  return decoded.value;
}

// System extensions (design 6.8): published extension packages share
// `system_versions` and are decoded with the extension codec.
export type PublishedExtensionLoader = (
  versionId: VersionId,
  transaction?: PoolClient,
) => Promise<ExtensionPackageV1 | null>;

export function createPostgresPublishedExtensionLoader(pool: Pool): PublishedExtensionLoader {
  return async (versionId, transaction) => {
    const result = await (transaction ?? pool).query<PublishedPackageRow>(
      `SELECT package_json, checksum
         FROM system_versions
        WHERE id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const decoded = decodeExtensionPackage(row.package_json);
    if (!decoded.ok || decoded.value.integrity.checksum !== row.checksum || decoded.value.versionId !== versionId) {
      throw new PublishedPackageCorruptError(versionId);
    }
    return decoded.value;
  };
}

export function createFixturePublishedExtensionLoader(
  packages: readonly ExtensionPackageV1[],
): PublishedExtensionLoader {
  return async (versionId) => {
    const found = packages.find((candidate) => candidate.versionId === versionId);
    if (found === undefined) return null;
    const decoded = decodeExtensionPackage(found);
    if (!decoded.ok) throw new PublishedPackageCorruptError(versionId);
    return decoded.value;
  };
}
