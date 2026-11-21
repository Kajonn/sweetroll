import type { RequestContext, Result } from "./authoring.js";
import type { ExtensionChoice } from "./extensions.js";
import type { VersionChoice, VersionId } from "./implementation/persistence/index.js";
import type { ExtensionRef } from "./implementation/rules/compose.js";
import { canonicalComposition, sameComposition, type Composition } from "./runtime.js";

// Design 6.7/6.8, extensions plan stage E5: a composition change replaces a
// record's base version and extension versions. One command makes one change
// (base upgrade, extension add, remove or upgrade) or reverts to the
// composition recorded before the most recent change.

export const MAX_COMPOSITION_EXTENSIONS = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompositionChange =
  | { kind: "revert" }
  | { kind: "system_upgrade"; fromVersionId: VersionId; toVersionId: VersionId }
  | { kind: "extension_add"; extensionId: string; versionId: VersionId }
  | { kind: "extension_remove"; extensionId: string; versionId: VersionId }
  | { kind: "extension_upgrade"; extensionId: string; fromVersionId: VersionId; toVersionId: VersionId };

/** Callers map these onto their own error shapes. */
export type CompositionError = { code: "invalid_value" | "bad_request" | "not_found" | "internal"; message: string };
export type CompositionResult<T> = { ok: true; value: T } | { ok: false; error: CompositionError };

export type CompositionActivityKind =
  | "system_version_upgraded"
  | "system_version_reverted"
  | "extension_added"
  | "extension_removed"
  | "extension_upgraded";

export type CompositionDescription = {
  systemVersion: VersionChoice;
  extensions: ExtensionChoice[];
};

export type CompositionOptions = {
  current: CompositionDescription;
  /** The composition recorded before the most recent change, if any. */
  revertTo: CompositionDescription | null;
  /** Later published versions of the base system the actor may use, newest first. */
  systemUpgrades: VersionChoice[];
  /** Extensions of the system that may be added, at their latest version. */
  available: ExtensionChoice[];
};

/** Reads a request body's composition; returns an error message when malformed. */
export function parseComposition(value: unknown): Composition | string {
  if (typeof value !== "object" || value === null) return "composition must be an object.";
  const { systemVersionId, extensions } = value as { systemVersionId?: unknown; extensions?: unknown };
  if (typeof systemVersionId !== "string" || !UUID_PATTERN.test(systemVersionId)) {
    return "composition.systemVersionId must be a version UUID.";
  }
  if (!Array.isArray(extensions)) return "composition.extensions must be an array.";
  if (extensions.length > MAX_COMPOSITION_EXTENSIONS) {
    return `A composition may use at most ${MAX_COMPOSITION_EXTENSIONS} extensions.`;
  }
  const refs: ExtensionRef[] = [];
  for (const ref of extensions as unknown[]) {
    const { extensionId, versionId } = (ref ?? {}) as { extensionId?: unknown; versionId?: unknown };
    if (typeof extensionId !== "string" || !UUID_PATTERN.test(extensionId)
      || typeof versionId !== "string" || !UUID_PATTERN.test(versionId)) {
      return "Each composition extension needs an extensionId and a versionId.";
    }
    refs.push({ extensionId, versionId });
  }
  if (new Set(refs.map((ref) => ref.extensionId)).size !== refs.length) return "Use one version of each extension.";
  return canonicalComposition({ systemVersionId, extensions: refs });
}

/**
 * Decides which single change moves `current` to `target`. A target equal to
 * the recorded previous composition is a revert, whatever it changes.
 */
export function classifyCompositionChange(
  current: Composition,
  target: Composition,
  previous: Composition | null,
): CompositionResult<CompositionChange> {
  if (sameComposition(current, target)) {
    return { ok: false, error: { code: "invalid_value", message: "The record already uses these rules." } };
  }
  if (previous !== null && sameComposition(previous, target)) return { ok: true, value: { kind: "revert" } };
  const changes: CompositionChange[] = [];
  if (current.systemVersionId !== target.systemVersionId) {
    changes.push({ kind: "system_upgrade", fromVersionId: current.systemVersionId, toVersionId: target.systemVersionId });
  }
  for (const ref of target.extensions) {
    const before = current.extensions.find((candidate) => candidate.extensionId === ref.extensionId);
    if (before === undefined) changes.push({ kind: "extension_add", extensionId: ref.extensionId, versionId: ref.versionId });
    else if (before.versionId !== ref.versionId) {
      changes.push({ kind: "extension_upgrade", extensionId: ref.extensionId, fromVersionId: before.versionId, toVersionId: ref.versionId });
    }
  }
  for (const ref of current.extensions) {
    if (!target.extensions.some((candidate) => candidate.extensionId === ref.extensionId)) {
      changes.push({ kind: "extension_remove", extensionId: ref.extensionId, versionId: ref.versionId });
    }
  }
  if (changes.length !== 1) {
    return {
      ok: false,
      error: { code: "bad_request", message: "Change one part of the rules at a time: the base version, or one extension." },
    };
  }
  return { ok: true, value: changes[0]! };
}

export type CompositionAuthorizers = {
  listSystemUpgrades: (ctx: RequestContext, fromVersionId: VersionId) => Promise<Result<VersionChoice[]>>;
  listExtensionUpgrades: (ctx: RequestContext, fromVersionId: VersionId) => Promise<Result<VersionChoice[]>>;
  authorizeExtensionUse: (
    ctx: RequestContext,
    versionId: VersionId,
  ) => Promise<Result<{ extensionId: string; baseSystemId: string }>>;
};

/**
 * The actor may make this change: an upgrade names a later usable version, an
 * added extension is usable and extends `systemId`. Removal and revert need no
 * use authorization (the record already pins those versions).
 */
export async function authorizeCompositionChange(
  ctx: RequestContext,
  change: CompositionChange,
  systemId: string,
  authorizers: CompositionAuthorizers,
): Promise<CompositionResult<null>> {
  const unavailable = (message: string): CompositionResult<null> => ({ ok: false, error: { code: "not_found", message } });
  switch (change.kind) {
    case "revert":
    case "extension_remove":
      return { ok: true, value: null };
    case "system_upgrade": {
      const targets = await authorizers.listSystemUpgrades(ctx, change.fromVersionId);
      if (!targets.ok) return internal();
      return targets.value.some((choice) => choice.versionId === change.toVersionId)
        ? { ok: true, value: null }
        : unavailable("The target version is not an available upgrade.");
    }
    case "extension_upgrade": {
      const targets = await authorizers.listExtensionUpgrades(ctx, change.fromVersionId);
      if (!targets.ok) return internal();
      return targets.value.some((choice) => choice.versionId === change.toVersionId && choice.systemId === change.extensionId)
        ? { ok: true, value: null }
        : unavailable("The target extension version is not an available upgrade.");
    }
    case "extension_add": {
      const use = await authorizers.authorizeExtensionUse(ctx, change.versionId);
      if (!use.ok) return use.error.code === "not_found" ? unavailable("The extension is not available.") : internal();
      return use.value.extensionId === change.extensionId && use.value.baseSystemId === systemId
        ? { ok: true, value: null }
        : unavailable("The extension is not available for this system.");
    }
  }
}

function internal(): CompositionResult<null> {
  return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
}

export function compositionActivityKind(change: CompositionChange): CompositionActivityKind {
  switch (change.kind) {
    case "revert": return "system_version_reverted";
    case "system_upgrade": return "system_version_upgraded";
    case "extension_add": return "extension_added";
    case "extension_remove": return "extension_removed";
    case "extension_upgrade": return "extension_upgraded";
  }
}

export function compositionActivitySummary(change: CompositionChange): string {
  switch (change.kind) {
    case "revert": return "Rules reverted";
    case "system_upgrade": return "System version upgraded";
    case "extension_add": return "Extension added";
    case "extension_remove": return "Extension removed";
    case "extension_upgrade": return "Extension upgraded";
  }
}
