import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import type { SystemPackageV1, UnsignedSystemPackageV1 } from "./schema/index.js";

function checksumInput(value: SystemPackageV1 | UnsignedSystemPackageV1): unknown {
  return { ...value, integrity: {} };
}

export function canonicalizePackage(value: SystemPackageV1 | UnsignedSystemPackageV1): string {
  return canonicalize(checksumInput(value));
}

export function calculatePackageChecksum(value: SystemPackageV1 | UnsignedSystemPackageV1): string {
  return `sha256:${createHash("sha256").update(canonicalizePackage(value), "utf8").digest("hex")}`;
}

export function signSystemPackage(value: UnsignedSystemPackageV1): SystemPackageV1 {
  const unsigned = structuredClone(value);
  return { ...unsigned, integrity: { checksum: calculatePackageChecksum(unsigned) } };
}
