import { PACKAGE_LIMITS } from "../package/limits.js";
import type { CompiledExpressionV1, ExpressionAstV1, ScalarValue, ValueType } from "../package/schema/index.js";
import { countNodes, depthOf, parse } from "./parser.js";
import { checkDeterministic, inferType, resolveDependencies, type ExpressionCompileEnv } from "./typecheck.js";
import type { RulesDiagnostic } from "./diagnostic.js";

export type CompileResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: RulesDiagnostic[] };

export type CompileExpressionOpts = {
  env: ExpressionCompileEnv;
  resultType: ValueType;
  context: "computed" | "roll" | "validation";
  fallback: ScalarValue;
};

export type CompiledExpressionBody = Omit<CompiledExpressionV1, "id">;

function fallbackTypeMatches(fallback: ScalarValue, resultType: ValueType): boolean {
  if (fallback === null || fallback === undefined) return false;
  if (resultType === "number") return typeof fallback === "number";
  if (resultType === "text") return typeof fallback === "string";
  return typeof fallback === "boolean";
}

export function compileAst(ast: ExpressionAstV1, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody> {
  const nodes = countNodes(ast);
  const depth = depthOf(ast);
  if (nodes > PACKAGE_LIMITS.expressionAstNodes) {
    return { ok: false, diagnostics: [{ code: "limit_exceeded", path: "", message: "expression exceeds node budget" }] };
  }
  if (depth > PACKAGE_LIMITS.expressionAstDepth) {
    return { ok: false, diagnostics: [{ code: "limit_exceeded", path: "", message: "expression exceeds depth budget" }] };
  }
  const det = checkDeterministic(ast, opts.context);
  if (det.length > 0) return { ok: false, diagnostics: det };
  const inferred = inferType(ast, opts.env);
  if (!inferred.ok) return { ok: false, diagnostics: inferred.diagnostics };
  if (inferred.type !== opts.resultType) {
    return { ok: false, diagnostics: [{ code: "invalid_expression", path: "", message: `inferred type ${inferred.type} does not match declared ${opts.resultType}` }] };
  }
  if (!fallbackTypeMatches(opts.fallback, opts.resultType)) {
    return { ok: false, diagnostics: [{ code: "invalid_expression", path: "", message: "fallback type does not match result type" }] };
  }
  return {
    ok: true,
    value: {
      resultType: opts.resultType,
      inferredType: inferred.type,
      fallback: opts.fallback,
      dependencies: resolveDependencies(ast),
      cost: nodes,
      ast,
    },
  };
}

export function compileExpression(source: string, opts: CompileExpressionOpts): CompileResult<CompiledExpressionBody> {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return compileAst(parsed.ast, opts);
}
