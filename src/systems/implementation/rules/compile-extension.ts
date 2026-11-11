import { fieldWithDatasetOptions } from "../package/reference-data.js";
import { signExtensionPackage } from "../package/canonical.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import type {
  ExtensionDocumentV1,
  ExtensionPackageV1,
  GrantedRollActionV1,
  ObjectTemplateV1,
  SystemPackageV1,
  UnsignedExtensionPackageV1,
} from "../package/schema/index.js";
import { validateExtensionDocumentStructure } from "../package/extension.js";
import type { PackageDiagnostic } from "../package/diagnostics.js";
import { compileAst, compileExpression, type CompileResult, type CompiledExpressionBody } from "./compile.js";
import {
  actionInputTypes,
  cycleInComputedFields,
  grantedEntityFieldsForKind,
} from "./compile-document.js";
import { entityFieldTypes, type ExpressionCompileEnv } from "./typecheck.js";

// System extensions (plan 2026-11-07-system-extensions, stage E1). An
// extension is compiled and validated against one published base package
// (decision X3/X4). Its expressions are owned by its own templates only:
// computed template fields and granted roll actions. A granted roll may read
// the template's fields and the character fields the base exposes to that
// template kind (`grantedEntityFieldsForKind`), exactly like base templates.

export type CompileExtensionOpts = {
  extensionId: string;
  versionId: string;
  semanticVersion: string;
};

export type ExtensionCheck = {
  /** Non-blocking findings, e.g. a template kind no base sheet slot accepts. */
  warnings: PackageDiagnostic[];
};

export type CompiledExtension = ExtensionCheck & { package: ExtensionPackageV1 };

type ExpressionOwner =
  | { kind: "computed"; template: ObjectTemplateV1 }
  | { kind: "roll"; template: ObjectTemplateV1; action: GrantedRollActionV1 };

export function compileExtensionDocument(
  document: ExtensionDocumentV1,
  base: SystemPackageV1,
  opts: CompileExtensionOpts,
): CompileResult<CompiledExtension> {
  const structural = validateExtensionDocumentStructure(document);
  if (structural.length > 0) return { ok: false, diagnostics: structural };

  for (const template of document.templates) {
    for (const field of template.fields) {
      if ((field.kind === "singleChoice" || field.kind === "multiChoice") && field.optionsFrom !== undefined
        && !base.referenceData.some(dataset => dataset.id === field.optionsFrom)) {
        return fail("missing_reference", `/templates/${template.id}/fields/${field.id}/optionsFrom`, "Dataset does not exist in the base system.");
      }
    }
  }

  const owners = expressionOwners(document.expressions, document.templates);
  if (!owners.ok) return owners;

  const compiled: CompiledExpressionBody[] = [];
  for (const [index, expression] of document.expressions.entries()) {
    const result = compileExpression(expression.source, {
      env: environmentFor(owners.value.get(expression.id), base),
      resultType: expression.resultType,
      context: expression.context,
      fallback: expression.fallback,
    });
    if (!result.ok) {
      return {
        ok: false,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `/expressions/${index}`,
        })),
      };
    }
    compiled.push(result.value);
  }

  const compiledById = new Map(document.expressions.map((expression, index) => [expression.id, compiled[index]!]));
  for (const template of document.templates) {
    const computed = new Map(template.fields
      .filter((field) => field.kind === "computed")
      .map((field) => [field.id, field]));
    const cycle = cycleInComputedFields(computed, compiledById);
    if (cycle !== undefined) {
      return fail("invalid_expression", cycle, "Computed field dependency cycle detected.");
    }
  }

  const unsigned: UnsignedExtensionPackageV1 = {
    schemaVersion: "2.0",
    extensionId: opts.extensionId,
    versionId: opts.versionId,
    semanticVersion: opts.semanticVersion,
    baseSystemId: base.systemId,
    builtAgainstVersionId: base.versionId,
    name: document.metadata.name,
    description: document.metadata.description,
    language: document.metadata.language,
    expressions: compiled.map((body, index) => ({ id: document.expressions[index]!.id, ...body })),
    templates: document.templates.map(template => ({ ...template, fields: template.fields.map(field => fieldWithDatasetOptions(field, base.referenceData)) })),
    effectiveLimits: {
      expressionBytes: PACKAGE_LIMITS.expressionBytes,
      expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
      expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
      sheetEvaluationNodes: PACKAGE_LIMITS.sheetEvaluationNodes,
      dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
      sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
    },
  };
  const signed = signExtensionPackage(unsigned);
  const check = validateExtensionAgainst(base, signed);
  if (!check.ok) return check;
  return { ok: true, value: { package: signed, warnings: check.value.warnings } };
}

/**
 * Decision X4: an extension version may be combined with any version of its
 * system for which every expression still typechecks with the character
 * fields that base version exposes. Extensions never see each other.
 */
export function validateExtensionAgainst(
  base: SystemPackageV1,
  extension: ExtensionPackageV1,
): CompileResult<ExtensionCheck> {
  if (extension.baseSystemId !== base.systemId) {
    return fail("extension_base_mismatch", "/baseSystemId", "Extension belongs to a different system.");
  }
  for (const template of extension.templates) {
    for (const field of template.fields) {
      if ((field.kind !== "singleChoice" && field.kind !== "multiChoice") || field.optionsFrom === undefined) continue;
      const resolved = fieldWithDatasetOptions(field, base.referenceData);
      const defaults = Array.isArray(field.default) ? field.default : field.default === null ? [] : [field.default];
      if (resolved === field || !("options" in resolved)
        || defaults.some(id => !resolved.options.some(option => option.id === id))
        || resolved.options.length !== field.options.length
        || resolved.options.some((option, index) => option.id !== field.options[index]?.id || option.label !== field.options[index]?.label)) {
        return fail("extension_incompatible", `/templates/${template.id}/fields/${field.id}/optionsFrom`, "The extension choice options differ from the base dataset.");
      }
    }
  }

  const owners = expressionOwners(extension.expressions, extension.templates);
  if (!owners.ok) return owners;

  for (const [index, expression] of extension.expressions.entries()) {
    const result = compileAst(expression.ast, {
      env: environmentFor(owners.value.get(expression.id), base),
      resultType: expression.resultType,
      context: expression.context,
      fallback: expression.fallback,
    });
    if (!result.ok) {
      return {
        ok: false,
        diagnostics: result.diagnostics.map((diagnostic) => ({
          code: "extension_incompatible",
          path: `/expressions/${index}`,
          message: `Expression "${expression.id}" does not fit system version ${base.semanticVersion}: ${diagnostic.message}`,
        })),
      };
    }
  }

  const placeable = placeableKinds(base);
  const warnings: PackageDiagnostic[] = [];
  for (const [index, template] of extension.templates.entries()) {
    if (!placeable.has(template.kind)) {
      warnings.push({
        code: "template_kind_unplaceable",
        path: `/templates/${index}/kind`,
        message: `No sheet slot in system version ${base.semanticVersion} accepts "${template.kind}" templates.`,
      });
    }
  }
  return { ok: true, value: { warnings } };
}

function expressionOwners(
  expressions: readonly { id: string; context: string }[],
  templates: readonly ObjectTemplateV1[],
): CompileResult<Map<string, ExpressionOwner>> {
  const owners = new Map<string, ExpressionOwner>();
  const contexts = new Map(expressions.map((expression) => [expression.id, expression.context]));
  const claim = (expressionId: string, owner: ExpressionOwner): string | undefined => {
    if (owners.has(expressionId)) return "Expression cannot be shared across different owners.";
    const context = contexts.get(expressionId);
    if (context !== owner.kind) return `Expression must have context "${owner.kind}".`;
    owners.set(expressionId, owner);
    return undefined;
  };
  for (const template of templates) {
    for (const field of template.fields) {
      if (field.kind !== "computed") continue;
      const problem = claim(field.expressionId, { kind: "computed", template });
      if (problem !== undefined) return fail("invalid_expression", field.expressionId, problem);
    }
    for (const action of template.grantedActions) {
      if (action.kind !== "roll") continue;
      const problem = claim(action.expressionId, { kind: "roll", template, action });
      if (problem !== undefined) return fail("invalid_expression", action.expressionId, problem);
    }
  }
  for (const expression of expressions) {
    if (expression.context === "validation") {
      return fail("invalid_expression", expression.id, "Extensions cannot contain validation expressions.");
    }
  }
  return { ok: true, value: owners };
}

function environmentFor(owner: ExpressionOwner | undefined, base: SystemPackageV1): ExpressionCompileEnv {
  const datasets = base.referenceData;
  if (owner === undefined) return { fields: {}, inputs: {}, datasets };
  const item = entityFieldTypes(owner.template.fields);
  if (owner.kind === "computed") return { fields: {}, inputs: {}, item, datasets };
  return {
    fields: grantedEntityFieldsForKind(base, owner.template.kind),
    inputs: actionInputTypes(owner.action.inputs), item, datasets,
  };
}

function placeableKinds(base: SystemPackageV1): Set<string> {
  const placed = new Set(base.sheets.flatMap((sheet) => sheet.sections.flatMap((section) =>
    section.elements.flatMap((element) => (element.kind === "slot" ? [element.slotId] : [])))));
  return new Set(base.slots
    .filter((slot) => placed.has(slot.id))
    .flatMap((slot) => slot.accepts));
}

function fail(code: string, path: string, message: string): CompileResult<never> {
  return { ok: false, diagnostics: [{ code, path, message }] };
}
