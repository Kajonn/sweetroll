import type { EvalResult } from "../rules/evaluate.js";
import type { RuntimeError } from "../../runtime.js";

/** Roll actions must never present a scalar fallback or partial dice as a factual roll. */
export function actionEvaluationFailure(
  result: Extract<EvalResult, { ok: true }>,
  actionId: string,
  expressionId: string,
): RuntimeError | null {
  const diagnostics = result.diagnostics.filter((d) => d.code === "arithmetic_failure");
  if (diagnostics.length === 0) return null;
  const actionDiagnostics = diagnostics.slice(0, 8).map((d) => ({
    code: "arithmetic_failure" as const,
    actionId,
    expressionId,
    message: d.message.slice(0, 256),
  }));
  return {
    code: "action_evaluation_failed",
    definitionId: actionId,
    message: `Roll could not be evaluated: ${actionDiagnostics[0]!.message}. Review the inputs or formula.`,
    actionDiagnostics,
  };
}
