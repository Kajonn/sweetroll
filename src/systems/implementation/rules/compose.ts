import { aggregateCall } from "./data.js";
import { children } from "./groups.js";
import { slotEnvironment } from "./slots.js";
import { inferType } from "./typecheck.js";
import { canonicalChecksum } from "../package/canonical.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import type {
  CompiledExpressionV1,
  ExpressionAstV1,
  ExtensionPackageV1,
  ObjectTemplateV1,
  SystemPackageV1,
} from "../package/schema/index.js";
import type { PackageDiagnostic } from "../package/diagnostics.js";
import type { CompileResult } from "./compile.js";
import { validateExtensionAgainst } from "./compile-extension.js";

// System extensions (plan 2026-11-07-system-extensions, stage E1). A
// composition is one base system version plus at most one version of each of
// up to 16 extensions (decision X6). Template and expression IDs are scoped by
// origin (decision X5): `null` is the base system, otherwise the stable
// extension ID. Nothing is renamed or merged into a single package.

/** `null` = base system; otherwise the extension ID. */
export type RulesOrigin = string | null;

export type CompositionIdentity = {
  systemVersionId: string;
  systemChecksum: string;
  /** Sorted by extensionId. */
  extensions: Array<{ extensionId: string; versionId: string; checksum: string }>;
};

export type OriginTemplate = { origin: RulesOrigin; template: ObjectTemplateV1 };

export type ComposedRules = {
  readonly base: SystemPackageV1;
  /** Sorted by extensionId. */
  readonly extensions: readonly ExtensionPackageV1[];
  readonly identity: CompositionIdentity;
  readonly compositionChecksum: string;
  /** Non-blocking per-extension findings, prefixed `/extensions/<extensionId>`. */
  readonly warnings: readonly PackageDiagnostic[];
  template(origin: RulesOrigin, templateId: string): ObjectTemplateV1 | undefined;
  expression(origin: RulesOrigin, expressionId: string): CompiledExpressionV1 | undefined;
  extension(extensionId: string): ExtensionPackageV1 | undefined;
  /** Base templates first, then each extension's in extensionId order. */
  templates(): OriginTemplate[];
};

export function compositionIdentity(
  base: SystemPackageV1,
  extensions: readonly ExtensionPackageV1[],
): CompositionIdentity {
  return {
    systemVersionId: base.versionId,
    systemChecksum: base.integrity.checksum,
    extensions: sortExtensions(extensions).map((extension) => ({
      extensionId: extension.extensionId,
      versionId: extension.versionId,
      checksum: extension.integrity.checksum,
    })),
  };
}

export function compositionChecksum(identity: CompositionIdentity): string {
  return canonicalChecksum(identity);
}

export function composeRules(
  base: SystemPackageV1,
  extensions: readonly ExtensionPackageV1[],
): CompileResult<ComposedRules> {
  if (extensions.length > PACKAGE_LIMITS.extensionsPerComposition) {
    return fail(
      "limit_exceeded",
      "/extensions",
      `A composition may contain at most ${PACKAGE_LIMITS.extensionsPerComposition} extensions.`,
    );
  }
  const sorted = sortExtensions(extensions);
  const warnings: PackageDiagnostic[] = [];
  const byId = new Map<string, ExtensionPackageV1>();
  for (const extension of sorted) {
    const path = `/extensions/${extension.extensionId}`;
    if (byId.has(extension.extensionId)) {
      return fail("duplicate_extension", path, "A composition may contain only one version of each extension.");
    }
    byId.set(extension.extensionId, extension);
    const check = validateExtensionAgainst(base, extension);
    if (!check.ok) {
      return {
        ok: false,
        diagnostics: check.diagnostics.map((diagnostic) => ({ ...diagnostic, path: `${path}${diagnostic.path}` })),
      };
    }
    warnings.push(...check.value.warnings.map((warning) => ({ ...warning, path: `${path}${warning.path}` })));
  }

  if (sorted.length > 0) {
    const templates = [...base.templates, ...sorted.flatMap(extension => extension.templates)];
    const slots = Object.assign({}, ...base.entities.map(entity => slotEnvironment(base, entity.id, templates)));
    const checkAggregates = (ast: ExpressionAstV1): PackageDiagnostic[] => {
      if (ast.kind === "call" && aggregateCall(ast) !== undefined) {
        const checked = inferType(ast, { fields: {}, inputs: {}, slots });
        return checked.ok ? [] : checked.diagnostics;
      }
      return children(ast).flatMap(checkAggregates);
    };
    for (const [index, expression] of base.expressions.entries()) {
      const diagnostics = checkAggregates(expression.ast);
      if (diagnostics.length > 0) {
        return { ok: false, diagnostics: diagnostics.map(diagnostic => ({
          ...diagnostic, code: "extension_incompatible", path: `/expressions/${index}`,
        })) };
      }
    }
  }

  const templateIndex = new Map<RulesOrigin, Map<string, ObjectTemplateV1>>([
    [null, new Map(base.templates.map((template) => [template.id, template]))],
  ]);
  const expressionIndex = new Map<RulesOrigin, Map<string, CompiledExpressionV1>>([
    [null, new Map(base.expressions.map((expression) => [expression.id, expression]))],
  ]);
  for (const extension of sorted) {
    templateIndex.set(extension.extensionId, new Map(extension.templates.map((template) => [template.id, template])));
    expressionIndex.set(extension.extensionId, new Map(extension.expressions.map((expression) => [expression.id, expression])));
  }

  const identity = compositionIdentity(base, sorted);
  const composed: ComposedRules = {
    base,
    extensions: sorted,
    identity,
    compositionChecksum: compositionChecksum(identity),
    warnings,
    template: (origin, templateId) => templateIndex.get(origin)?.get(templateId),
    expression: (origin, expressionId) => expressionIndex.get(origin)?.get(expressionId),
    extension: (extensionId) => byId.get(extensionId),
    templates: () => [
      ...base.templates.map((template) => ({ origin: null, template })),
      ...sorted.flatMap((extension) => extension.templates.map((template) => ({
        origin: extension.extensionId,
        template,
      }))),
    ],
  };
  return { ok: true, value: composed };
}

function sortExtensions(extensions: readonly ExtensionPackageV1[]): ExtensionPackageV1[] {
  return [...extensions].sort((a, b) =>
    a.extensionId.localeCompare(b.extensionId) || a.versionId.localeCompare(b.versionId));
}

function fail(code: string, path: string, message: string): CompileResult<never> {
  return { ok: false, diagnostics: [{ code, path, message }] };
}

// ---------------------------------------------------------------------------
// Effective package (stage E3)
// ---------------------------------------------------------------------------
//
// The character runtime works on one `SystemPackageV1`. For a composition it
// receives an in-memory *effective package*: the base package with each
// extension's templates and expressions appended under origin-qualified keys
// `<extensionId>:<id>`. ':' cannot occur in a definition ID, so qualified keys
// never collide with base IDs or with each other (decision X5). Template field
// and granted-action IDs stay unqualified because they are scoped to their
// template. Effective packages are never stored, exported or sent to clients;
// stored entries keep the plain `templateId` plus `extensionId`, and
// `templateKey(entry)` maps them to the qualified key. The base `versionId` and
// `integrity.checksum` are kept, so campaign-derived bases still match.

export type ExtensionRef = { extensionId: string; versionId: string };

const ORIGIN_SEPARATOR = ":";

export function qualifiedId(origin: RulesOrigin | undefined, id: string): string {
  return origin === null || origin === undefined ? id : `${origin}${ORIGIN_SEPARATOR}${id}`;
}

/** Splits a qualified key back into its origin and plain definition ID. */
export function unqualifiedId(key: string): { origin: RulesOrigin; id: string } {
  const index = key.indexOf(ORIGIN_SEPARATOR);
  return index < 0 ? { origin: null, id: key } : { origin: key.slice(0, index), id: key.slice(index + 1) };
}

const effectiveCompositions = new WeakMap<SystemPackageV1, { identity: CompositionIdentity; compositionChecksum: string }>();

export function effectivePackage(rules: ComposedRules): SystemPackageV1 {
  if (rules.extensions.length === 0) return rules.base;
  const qualifyTemplate = (origin: string, template: ObjectTemplateV1): ObjectTemplateV1 => ({
    ...template,
    id: qualifiedId(origin, template.id),
    fields: template.fields.map((field) => field.kind === "computed"
      ? { ...field, expressionId: qualifiedId(origin, field.expressionId) }
      : field),
    grantedActions: template.grantedActions.map((action) => action.kind === "roll"
      ? { ...action, expressionId: qualifiedId(origin, action.expressionId) }
      : action),
  });
  const effective: SystemPackageV1 = {
    ...rules.base,
    expressions: [
      ...rules.base.expressions,
      ...rules.extensions.flatMap((extension) => extension.expressions.map((expression) => ({
        ...expression,
        id: qualifiedId(extension.extensionId, expression.id),
      }))),
    ],
    templates: [
      ...rules.base.templates,
      ...rules.extensions.flatMap((extension) =>
        extension.templates.map((template) => qualifyTemplate(extension.extensionId, template))),
    ],
  };
  effectiveCompositions.set(effective, { identity: rules.identity, compositionChecksum: rules.compositionChecksum });
  return effective;
}

/** Composition of an effective package; `undefined` for a plain base package. */
export function compositionOf(pkg: SystemPackageV1): { identity: CompositionIdentity; compositionChecksum: string } | undefined {
  return effectiveCompositions.get(pkg);
}
