import type { ErrorObject } from "ajv";

export type PackageDiagnosticCode =
  | "checksum_mismatch"
  | "document_too_large"
  | "duplicate_definition_id"
  | "invalid_definition_id"
  | "invalid_json"
  | "invalid_schema"
  | "limit_exceeded"
  | "missing_reference";

export type PackageDiagnostic = {
  code: PackageDiagnosticCode;
  path: string;
  message: string;
};

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: PackageDiagnostic[] };

export function sortDiagnostics(values: PackageDiagnostic[]): PackageDiagnostic[] {
  const unique = new Map<string, PackageDiagnostic>();
  for (const value of values) {
    const key = `${value.code}\0${value.path}`;
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()].toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
  );
}

export function diagnosticsFromAjv(errors: ErrorObject[] | null | undefined): PackageDiagnostic[] {
  return sortDiagnostics((errors ?? []).map(diagnosticFromAjv));
}

function diagnosticFromAjv(error: ErrorObject): PackageDiagnostic {
  const path = keywordPath(error);
  if (error.keyword === "pattern" && error.params.pattern === "^[a-z][a-z0-9_]{0,63}$") {
    return { code: "invalid_definition_id", path, message: "Definition ID is invalid." };
  }
  if (
    error.keyword === "maximum" &&
    (path.startsWith("/effectiveLimits/") || path.startsWith("/package/effectiveLimits/"))
  ) {
    return {
      code: "limit_exceeded",
      path,
      message: "Effective limit exceeds the platform ceiling.",
    };
  }
  return {
    code: "invalid_schema",
    path,
    message: "Input does not match the required schema.",
  };
}

function keywordPath(error: ErrorObject): string {
  if (error.keyword === "required") {
    return appendPointer(error.instancePath, String(error.params.missingProperty));
  }
  if (error.keyword === "additionalProperties") {
    return appendPointer(error.instancePath, String(error.params.additionalProperty));
  }
  return error.instancePath;
}

function appendPointer(path: string, segment: string): string {
  return `${path}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
