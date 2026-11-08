import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import type {
  ExtensionPackageV1,
  SystemPackageV1,
  UnsignedExtensionPackageV1,
  UnsignedSystemPackageV1,
} from "./schema/index.js";

type ChecksummedPackage =
  | SystemPackageV1
  | UnsignedSystemPackageV1
  | ExtensionPackageV1
  | UnsignedExtensionPackageV1;

function checksumInput(value: ChecksummedPackage): unknown {
  return { ...value, integrity: {} };
}

export function canonicalizePackage(value: ChecksummedPackage): string {
  return canonicalize(checksumInput(value));
}

export function calculatePackageChecksum(value: ChecksummedPackage): string {
  return `sha256:${createHash("sha256").update(canonicalizePackage(value), "utf8").digest("hex")}`;
}

export function signSystemPackage(value: UnsignedSystemPackageV1): SystemPackageV1 {
  const unsigned = structuredClone(value);
  return { ...unsigned, integrity: { checksum: calculatePackageChecksum(unsigned) } };
}

export function signExtensionPackage(value: UnsignedExtensionPackageV1): ExtensionPackageV1 {
  const unsigned = structuredClone(value);
  return { ...unsigned, integrity: { checksum: calculatePackageChecksum(unsigned) } };
}

/** Hex SHA-256 of an arbitrary JSON value in canonical form. */
export function canonicalChecksum(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}
