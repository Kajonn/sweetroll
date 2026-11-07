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
// entity actions or validations. Extension expressions always use grammar 0.2
// with push policies, which the system checks gate on package version 1.2.

const ajv = new Ajv({ allErrors: true, strict: true });
const validateDocument = ajv.compile<ExtensionDocumentV1>(ExtensionDocumentV1Schema);
const validatePackage = ajv.compile<ExtensionPackageV1>(ExtensionPackageV1Schema);

export function validateExtensionDocumentStructure(value: ExtensionDocumentV1): PackageDiagnostic[] {
  const asSystem: SystemDocumentV1 = {
    schemaVersion: "1.2",
    metadata: { ...value.metadata, defaultDice: "" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: value.expressions,
    actions: [],
    validations: [],
    templates: value.templates,
  };
  return sortDiagnostics([...validateDocumentStructure(asSystem), ...validationExpressions(value.expressions)]);
}

export function validateExtensionPackageStructure(value: ExtensionPackageV1): PackageDiagnostic[] {
  const asSystem = {
    schemaVersion: "1.2",
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
    effectiveLimits: value.effectiveLimits,
    integrity: value.integrity,
  } satisfies SystemPackageV1;
  return sortDiagnostics([...validatePackageStructure(asSystem), ...validationExpressions(value.expressions)]);
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
  return expressions.flatMap((expression, index) => expression.context === "validation"
    ? [{
      code: "invalid_schema",
      path: `/expressions/${index}/context`,
      message: "Extensions cannot contain validation expressions.",
    }]
    : []);
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
