/** Public Systems capability for campaign derivation; mechanics remain package-owned. */
import type {
  SystemPackageV1,
  ObjectTemplateV1,
} from "./implementation/package/schema/index.js";
import {
  validDefaults,
  templateApplicable,
} from "./implementation/runtime/effective-entry.js";
export type { PublishedPackageLoader } from "./implementation/runtime/package-loader.js";
export function resolveTemplateBase(
  pkg: SystemPackageV1,
  id: string,
  kind: string,
  defaults: Record<string, unknown>,
): ObjectTemplateV1 | undefined {
  const t = (pkg.templates ?? []).find((t) => t.id === id && t.kind === kind);
  return t &&
    validDefaults(t, defaults) &&
    pkg.entities.some((e) => templateApplicable(pkg, e, t))
    ? t
    : undefined;
}
