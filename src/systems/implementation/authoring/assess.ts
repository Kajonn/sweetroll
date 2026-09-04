import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import { decodeSystemDocument } from "../package/codec.js";
import type { PackageDiagnostic } from "../package/diagnostics.js";
import type { SystemDocumentV1, SystemPackageV1 } from "../package/schema/index.js";
import { compileDocument } from "../rules/compile-document.js";
import { renderExpression } from "../rules/render.js";

const ASSESSMENT_SYSTEM_ID = "00000000-0000-4000-8000-000000000000";
const ASSESSMENT_VERSION_ID = "00000000-0000-4000-8000-000000000001";

export type PackageAssessment = {
  ok: boolean;
  diagnostics: PackageDiagnostic[];
};

export type AssessedDocument =
  | { ok: true; document: SystemDocumentV1; assessment: PackageAssessment }
  | { ok: false; document: SystemDocumentV1 | null; assessment: PackageAssessment };

export function blankSystemDocument(name: string): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name, description: "", language: "en", defaultDice: "d20" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: [],
    actions: [],
    validations: [],
  };
}

export function documentChecksum(document: SystemDocumentV1): string {
  return `sha256:${createHash("sha256").update(canonicalize(document), "utf8").digest("hex")}`;
}

export function hashInput(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function assessDocument(input: unknown): AssessedDocument {
  const decoded = decodeSystemDocument(input);
  if (!decoded.ok) {
    return { ok: false, document: null, assessment: { ok: false, diagnostics: decoded.diagnostics } };
  }
  const compiled = compileDocument(decoded.value, {
    systemId: ASSESSMENT_SYSTEM_ID,
    versionId: ASSESSMENT_VERSION_ID,
    semanticVersion: "0.0.0",
  });
  if (!compiled.ok) {
    return {
      ok: false,
      document: decoded.value,
      assessment: { ok: false, diagnostics: compiled.diagnostics },
    };
  }
  return { ok: true, document: decoded.value, assessment: { ok: true, diagnostics: [] } };
}

export function documentFromPackage(pkg: SystemPackageV1): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: {
      name: pkg.name,
      description: pkg.description,
      language: pkg.language,
      defaultDice: pkg.defaultDice,
    },
    entities: structuredClone(pkg.entities),
    referenceData: structuredClone(pkg.referenceData),
    sheets: structuredClone(pkg.sheets),
    expressions: pkg.expressions.map((expression) => ({
      id: expression.id,
      context: expression.context,
      resultType: expression.resultType,
      source: renderExpression(expression.ast),
      fallback: expression.fallback,
    })),
    actions: structuredClone(pkg.actions),
    validations: structuredClone(pkg.validations),
  };
}
