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
  return { audience: "preview", result: portEvaluateExpression(input) };
}

export type { EvaluateExpressionInput, EvaluateExpressionResult };
