import { Ajv, type ValidateFunction } from "ajv";

import { calculatePackageChecksum } from "./canonical.js";
import { parseInput } from "./codec.js";
import {
  diagnosticsFromAjv,
  sortDiagnostics,
  type DecodeResult,
  type PackageDiagnostic,
} from "./diagnostics.js";
import { PACKAGE_LIMITS } from "./limits.js";
import {
  ExtensionDocumentV1Schema,
  ExtensionPackageV1Schema,
  type ExtensionDocumentV1,
  type ExtensionPackageV1,
  type SystemDocumentV1,
  type SystemPackageV1,
} from "./schema/index.js";
import {
  preflightPackageAstLimits,
  validateDocumentStructure,
  validatePackageStructure,
} from "./structural.js";

// System extensions (plan 2026-11-07-system-extensions, stage E1). Extension
// documents and packages reuse the system structural checks (unique IDs,
// expression/resource references, budgets, push policies) by presenting their
// templates and expressions as a system with no entities, sheets, slots,
// entity actions or validations. Extensions use the same grammar as systems.

const ajv = new Ajv({ allErrors: true, strict: true });
const validateDocument = ajv.compile<ExtensionDocumentV1>(ExtensionDocumentV1Schema);
const validatePackage = ajv.compile<ExtensionPackageV1>(ExtensionPackageV1Schema);

export function validateExtensionDocumentStructure(value: ExtensionDocumentV1): PackageDiagnostic[] {
  const asSystem: SystemDocumentV1 = {
    schemaVersion: "2.0",
    metadata: { ...value.metadata, defaultDice: "" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: value.expressions,
    actions: [],
    validations: [],
    templates: value.templates,
    slots: [],
  };
  return sortDiagnostics([...validateDocumentStructure(asSystem, true), ...validationExpressions(value.expressions), ...extensionOutcomes(value.templates)]);
}

export function validateExtensionPackageStructure(value: ExtensionPackageV1): PackageDiagnostic[] {
  const asSystem = {
    schemaVersion: "2.0",
    systemId: value.baseSystemId,
    versionId: value.versionId,
    semanticVersion: value.semanticVersion,
    name: value.name,
    description: value.description,
    language: value.language,
    defaultDice: "",
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: value.expressions,
    actions: [],
    validations: [],
    templates: value.templates,
    slots: [],
    effectiveLimits: value.effectiveLimits,
    integrity: value.integrity,
  } satisfies SystemPackageV1;
  return sortDiagnostics([...validatePackageStructure(asSystem, "", true), ...validationExpressions(value.expressions)]);
}

export function decodeExtensionDocument(input: unknown): DecodeResult<ExtensionDocumentV1> {
  return noThrow(() => {
    const parsed = parseInput(input, PACKAGE_LIMITS.encodedBytes);
    if (!parsed.ok) return parsed;
    return validateWith(parsed.value, validateDocument, validateExtensionDocumentStructure);
  });
}

export function decodeExtensionPackage(input: unknown): DecodeResult<ExtensionPackageV1> {
  return noThrow(() => {
    const parsed = parseInput(input, PACKAGE_LIMITS.encodedBytes);
    if (!parsed.ok) return parsed;
    const preflight = sortDiagnostics(preflightPackageAstLimits(parsed.value));
    if (preflight.length > 0) return { ok: false, diagnostics: preflight };
    const decoded = validateWith(parsed.value, validatePackage, validateExtensionPackageStructure);
    if (!decoded.ok) return decoded;
    if (decoded.value.integrity.checksum !== calculatePackageChecksum(decoded.value)) {
      return {
        ok: false,
        diagnostics: [{
          code: "checksum_mismatch",
          path: "/integrity/checksum",
          message: "Package checksum does not match.",
        }],
      };
    }
    return decoded;
  });
}

function validationExpressions(expressions: readonly { context: string }[]): PackageDiagnostic[] {
  // Outcome bands on extension actions are not supported yet (rules coverage R5).
  return expressions.flatMap((expression, index) => expression.context === "validation" || expression.context === "outcome"
    ? [{
      code: "invalid_schema",
      path: `/expressions/${index}/context`,
      message: expression.context === "validation"
        ? "Extensions cannot contain validation expressions."
        : "Extensions cannot contain outcome expressions yet.",
    }]
    : []);
}

function extensionOutcomes(templates: ExtensionDocumentV1["templates"]): PackageDiagnostic[] {
  return templates.flatMap((template, templateIndex) => template.grantedActions.flatMap((action, actionIndex) =>
    action.kind === "roll" && ((action.outcomes?.length ?? 0) > 0 || (action.details?.length ?? 0) > 0)
      ? [{
        code: "invalid_schema",
        path: `/templates/${templateIndex}/grantedActions/${actionIndex}/outcomes`,
        message: "Actions in extensions cannot define outcomes or details yet.",
      }]
      : []));
}

function validateWith<T>(
  value: unknown,
  validator: ValidateFunction<T>,
  structural: (value: T) => PackageDiagnostic[],
): DecodeResult<T> {
  if (!validator(value)) return { ok: false, diagnostics: diagnosticsFromAjv(validator.errors) };
  const diagnostics = structural(value);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: structuredClone(value) };
}

function noThrow<T>(operation: () => DecodeResult<T>): DecodeResult<T> {
  try {
    return operation();
  } catch {
    return {
      ok: false,
      diagnostics: [{ code: "invalid_schema", path: "", message: "Input does not match the required schema." }],
    };
  }
}
