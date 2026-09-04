import { Buffer } from "node:buffer";

import { Ajv, type ValidateFunction } from "ajv";

import { calculatePackageChecksum } from "./canonical.js";
import {
  diagnosticsFromAjv,
  sortDiagnostics,
  type DecodeResult,
  type PackageDiagnostic,
} from "./diagnostics.js";
import {
  SystemDocumentV1Schema,
  SystemExportV1Schema,
  SystemPackageV1Schema,
  type SystemDocumentV1,
  type SystemExportV1,
  type SystemPackageV1,
} from "./schema/index.js";
import {
  preflightExportAstLimits,
  preflightPackageAstLimits,
  validateDocumentStructure,
  validatePackageStructure,
} from "./structural.js";
import { PACKAGE_LIMITS } from "./limits.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validateDocument = ajv.compile<SystemDocumentV1>(SystemDocumentV1Schema);
const validatePackage = ajv.compile<SystemPackageV1>(SystemPackageV1Schema);
const validateExport = ajv.compile<SystemExportV1>(SystemExportV1Schema);

export function decodeSystemDocument(input: unknown): DecodeResult<SystemDocumentV1> {
  return noThrow(() => decode(input, validateDocument, validateDocumentStructure));
}

export function decodeSystemPackage(input: unknown): DecodeResult<SystemPackageV1> {
  return noThrow(() => decode(
    input,
    validatePackage,
    validatePackageStructure,
    preflightPackageAstLimits,
    (value) => verifyPackageChecksum(value),
  ));
}

export function decodeSystemExport(input: unknown): DecodeResult<SystemExportV1> {
  return noThrow(() => decode(
    input,
    validateExport,
    (value) => validatePackageStructure(value.package, "/package"),
    preflightExportAstLimits,
    (value) => verifyPackageChecksum(value.package, "/package"),
  ));
}

function decode<T>(
  input: unknown,
  validator: ValidateFunction<T>,
  structuralCheck: (value: T) => ReturnType<typeof validateDocumentStructure>,
  preflight?: (value: unknown) => ReturnType<typeof validateDocumentStructure>,
  postValidate?: (value: T) => ReturnType<typeof verifyPackageChecksum>,
): DecodeResult<T> {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;

  const preflightDiagnostics = sortDiagnostics(preflight?.(parsed.value) ?? []);
  if (preflightDiagnostics.length > 0) {
    return { ok: false, diagnostics: preflightDiagnostics };
  }
  if (!validator(parsed.value)) {
    return { ok: false, diagnostics: diagnosticsFromAjv(validator.errors) };
  }
  const diagnostics = sortDiagnostics(structuralCheck(parsed.value));
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const postDiagnostics = sortDiagnostics(postValidate?.(parsed.value as T) ?? []);
  if (postDiagnostics.length > 0) return { ok: false, diagnostics: postDiagnostics };
  return { ok: true, value: structuredClone(parsed.value) };
}

function verifyPackageChecksum(value: SystemPackageV1, prefix = ""): PackageDiagnostic[] {
  const expected = calculatePackageChecksum(value);
  if (value.integrity.checksum === expected) return [];
  return [{
    code: "checksum_mismatch",
    path: `${prefix}/integrity/checksum`,
    message: "Package checksum does not match.",
  }];
}

function noThrow<T>(operation: () => DecodeResult<T>): DecodeResult<T> {
  try {
    return operation();
  } catch {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_schema",
        path: "",
        message: "Input does not match the required schema.",
      }],
    };
  }
}

function parseInput(input: unknown): DecodeResult<unknown> {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return { ok: true, value: input };
  }

  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (bytes.byteLength > PACKAGE_LIMITS.encodedBytes) {
    return {
      ok: false,
      diagnostics: [{
        code: "document_too_large",
        path: "",
        message: `Input exceeds ${PACKAGE_LIMITS.encodedBytes} bytes.`,
      }],
    };
  }

  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_json",
        path: "",
        message: "Input is not valid JSON.",
      }],
    };
  }
}
