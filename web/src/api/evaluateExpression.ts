import {
  evaluateExpression as portEvaluateExpression,
  type EvaluateExpressionInput,
  type EvaluateExpressionResult,
} from "../ports/evaluateExpression.js";

export type RollAudience = "preview";

export type RollEvaluation = {
  audience: RollAudience;
  result: EvaluateExpressionResult;
};

export function evaluateRoll(input: EvaluateExpressionInput): RollEvaluation {
  const result = portEvaluateExpression(input);
  return {
    audience: "preview",
    result: result.ok && result.diagnostics.length > 0
      ? { ok: false, expression: result.expression, diagnostics: result.diagnostics }
      : result,
  };
}

export type { EvaluateExpressionInput, EvaluateExpressionResult };
