import type { PoolClient } from "pg";

import type { SystemPackageV1 } from "../package/schema/index.js";
import { composeRules, effectivePackage, type ExtensionRef } from "../rules/compose.js";
import {
  PublishedPackageCorruptError,
  type PublishedExtensionLoader,
  type PublishedPackageLoader,
} from "./package-loader.js";

// System extensions, stage E3 (design 6.8). Loads a base system version plus
// the extension versions a character or campaign is built on and returns the
// effective package the runtime evaluates (see `effectivePackage`). Published
// packages are immutable, so composed results are memoized by their version
// IDs; checksums are verified on every load by the underlying loaders.

export type CompositionLoadError =
  | { code: "not_found"; message: string }
  | { code: "invalid_package"; message: string; versionId?: string }
  | { code: "internal"; message: string };

export type CompositionLoadResult =
  | { ok: true; value: SystemPackageV1 }
  | { ok: false; error: CompositionLoadError };

export type EffectivePackageLoader = (
  versionId: string,
  extensions: readonly ExtensionRef[] | undefined,
  transaction?: PoolClient,
) => Promise<CompositionLoadResult>;

const MEMO_LIMIT = 128;

export function createEffectivePackageLoader(input: {
  loadPackage: PublishedPackageLoader;
  loadExtensionPackage?: PublishedExtensionLoader;
}): EffectivePackageLoader {
  const memo = new Map<string, SystemPackageV1>();
  return async (versionId, extensions, transaction) => {
    try {
      const base = await input.loadPackage(versionId, transaction);
      if (base === null) return { ok: false, error: { code: "not_found", message: "Published version not found." } };
      if (base.versionId !== versionId) {
        return { ok: false, error: { code: "invalid_package", message: "Published package version differs from the request." } };
      }
      if (extensions === undefined || extensions.length === 0) return { ok: true, value: base };
      if (input.loadExtensionPackage === undefined) {
        return { ok: false, error: { code: "internal", message: "Extension packages cannot be loaded." } };
      }
      const key = [versionId, ...extensions.map((ref) => `${ref.extensionId}@${ref.versionId}`).sort()].join("|");
      const cached = memo.get(key);
      if (cached !== undefined && cached.integrity.checksum === base.integrity.checksum) return { ok: true, value: cached };

      const loaded = [];
      for (const ref of extensions) {
        const extension = await input.loadExtensionPackage(ref.versionId, transaction);
        if (extension === null) return { ok: false, error: { code: "not_found", message: "Extension version not found." } };
        if (extension.extensionId !== ref.extensionId) {
          return { ok: false, error: { code: "invalid_package", message: "Extension version belongs to another extension.", versionId: ref.versionId } };
        }
        loaded.push(extension);
      }
      const composed = composeRules(base, loaded);
      if (!composed.ok) {
        return {
          ok: false,
          error: { code: "invalid_package", message: composed.diagnostics[0]?.message ?? "The extensions do not fit this system version." },
        };
      }
      const effective = effectivePackage(composed.value);
      if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
      memo.set(key, effective);
      return { ok: true, value: effective };
    } catch (error) {
      if (error instanceof PublishedPackageCorruptError) {
        return { ok: false, error: { code: "invalid_package", message: "Published package is corrupt.", versionId: error.versionId } };
      }
      return { ok: false, error: { code: "internal", message: "Package loading failed." } };
    }
  };
}
