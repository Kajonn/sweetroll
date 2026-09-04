import { Buffer } from "node:buffer";

import { Ajv, type ValidateFunction } from "ajv";

import {
  diagnosticsFromAjv,
  sortDiagnostics,
  type DecodeResult,
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
  validateDocumentStructure,
  validatePackageStructure,
} from "./structural.js";
import { PACKAGE_LIMITS } from "./limits.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validateDocument = ajv.compile<SystemDocumentV1>(SystemDocumentV1Schema);
const validatePackage = ajv.compile<SystemPackageV1>(SystemPackageV1Schema);
const validateExport = ajv.compile<SystemExportV1>(SystemExportV1Schema);

export function decodeSystemDocument(input: unknown): DecodeResult<SystemDocumentV1> {
  return decode(input, validateDocument, validateDocumentStructure);
}

export function decodeSystemPackage(input: unknown): DecodeResult<SystemPackageV1> {
  return decode(input, validatePackage, validatePackageStructure);
}

export function decodeSystemExport(input: unknown): DecodeResult<SystemExportV1> {
  return decode(input, validateExport, (value) => validatePackageStructure(value.package, "/package"));
}

function decode<T>(
  input: unknown,
  validator: ValidateFunction<T>,
  structuralCheck: (value: T) => ReturnType<typeof validateDocumentStructure>,
): DecodeResult<T> {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;

  try {
    if (!validator(parsed.value)) {
      return { ok: false, diagnostics: diagnosticsFromAjv(validator.errors) };
    }
    const diagnostics = sortDiagnostics(structuralCheck(parsed.value));
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    return { ok: true, value: structuredClone(parsed.value) };
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
