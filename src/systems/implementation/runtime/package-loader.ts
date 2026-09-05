import type { Pool } from "pg";

import type { VersionId } from "../../runtime.js";
import { decodeSystemPackage } from "../package/codec.js";
import type { SystemPackageV1 } from "../package/schema/index.js";

export type PublishedPackageLoader = (
  versionId: VersionId,
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

export function createPostgresPublishedPackageLoader(pool: Pool): PublishedPackageLoader {
  return async (versionId) => {
    const result = await pool.query<PublishedPackageRow>(
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
    const packageValue = packages.find((candidate) => candidate.versionId === versionId);
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
