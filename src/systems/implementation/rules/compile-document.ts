import type { FieldV1, SystemDocumentV1, SystemPackageV1, ValueType } from "../package/schema/index.js";
import type { UnsignedSystemPackageV1 } from "../package/schema/index.js";
import { signSystemPackage } from "../package/canonical.js";
import { PACKAGE_LIMITS } from "../package/limits.js";
import { compileExpression, type CompileResult } from "./compile.js";
import type { ExpressionCompileEnv } from "./typecheck.js";

export type CompileDocumentOpts = {
  systemId: string;
  versionId: string;
  semanticVersion: string;
};

function fieldToValueType(field: FieldV1): ValueType | undefined {
  switch (field.kind) {
    case "text": return "text";
    case "integer": return "number";
    case "decimal": return "number";
    case "boolean": return "boolean";
    case "singleChoice": return "text";
    case "multiChoice": return "text";
    case "resource": return "number";
    case "computed": return field.valueType;
    case "image": return undefined;
  }
}

function actionInputToValueType(input: { valueType: string }): ValueType {
  switch (input.valueType) {
    case "integer": return "number";
    case "decimal": return "number";
    case "boolean": return "boolean";
    case "text": return "text";
  }
  return "text";
}

export function compileDocument(document: SystemDocumentV1, opts: CompileDocumentOpts): CompileResult<SystemPackageV1> {
  const env: ExpressionCompileEnv = { fields: {}, inputs: {} };

  for (const entity of document.entities) {
    for (const field of entity.fields) {
      if (field.id in env.fields) continue;
      const vt = fieldToValueType(field);
      if (vt !== undefined) {
        env.fields[field.id] = vt;
      }
    }
  }

  for (const action of document.actions) {
    if (action.kind !== "roll") continue;
    for (const input of action.inputs) {
      env.inputs[input.id] = actionInputToValueType(input);
    }
  }

  const compiled: { resultType: ValueType; inferredType: ValueType; fallback: boolean | number | string | null; dependencies: string[]; cost: number; ast: import("../package/schema/index.js").ExpressionAstV1 }[] = [];

  for (const expr of document.expressions) {
    const result = compileExpression(expr.source, {
      env,
      resultType: expr.resultType,
      context: expr.context,
      fallback: expr.fallback,
    });
    if (!result.ok) {
      return {
        ok: false,
        diagnostics: result.diagnostics.map((d) => ({ ...d, path: expr.id })),
      };
    }
    compiled.push(result.value);
  }

  const unsigned: UnsignedSystemPackageV1 = {
    schemaVersion: "1.0",
    systemId: opts.systemId,
    versionId: opts.versionId,
    semanticVersion: opts.semanticVersion,
    name: document.metadata.name,
    description: document.metadata.description,
    language: document.metadata.language,
    defaultDice: document.metadata.defaultDice,
    entities: document.entities,
    referenceData: document.referenceData,
    sheets: document.sheets,
    expressions: compiled.map((b, i) => ({ id: document.expressions[i]!.id, ...b })),
    actions: document.actions,
    validations: document.validations,
    effectiveLimits: {
      expressionBytes: PACKAGE_LIMITS.expressionBytes,
      expressionAstNodes: PACKAGE_LIMITS.expressionAstNodes,
      expressionAstDepth: PACKAGE_LIMITS.expressionAstDepth,
      dicePerRoll: PACKAGE_LIMITS.dicePerRoll,
      sidesPerDie: PACKAGE_LIMITS.sidesPerDie,
    },
  };

  return { ok: true, value: signSystemPackage(unsigned) };
}
