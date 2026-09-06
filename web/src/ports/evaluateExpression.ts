import {
  compileExpression,
  evaluate,
  renderExpression,
  type CompiledExpressionV1,
  type EvalResult,
  type EvaluationBindings,
  type ExpressionAstV1,
  type Rng,
  type ScalarValue,
  type ValueType,
} from "@sweetroll/rules";

export type { ScalarValue, ValueType };

export type ExpressionEnv = {
  fields: Record<string, ValueType>;
  inputs: Record<string, ValueType>;
};

export type EvaluateExpressionInput = {
  source: string;
  env: ExpressionEnv;
  resultType: ValueType;
  fallback: ScalarValue;
  bindings: Record<string, ScalarValue>;
  rng?: Rng;
};

export type EvaluateDiagnostic = { code: string; path: string; message: string };

export type DieResult = { sides: number; value: number; kept: boolean };

/** `EvaluationBindings` with its scopes populated from the flat binding map. */
type EvaluateExpressionBindings = EvaluationBindings;

function pickBindings(
  all: Record<string, ScalarValue>,
  scope: Record<string, ValueType>,
): Record<string, ScalarValue> {
  const picked: Record<string, ScalarValue> = {};
  for (const id of Object.keys(all)) {
    if (Object.prototype.hasOwnProperty.call(scope, id)) picked[id] = all[id]!;
  }
  return picked;
}

export type EvaluateExpressionResult =
  | {
      ok: true;
      expression: string;
      ast: ExpressionAstV1;
      value: ScalarValue;
      roll: { total: number; dice: DieResult[]; expression: string } | null;
      diagnostics: EvaluateDiagnostic[];
    }
  | { ok: false; expression: string | null; diagnostics: EvaluateDiagnostic[] };

export function evaluateExpression(input: EvaluateExpressionInput): EvaluateExpressionResult {
  const compiled = compileExpression(input.source, {
    env: input.env,
    resultType: input.resultType,
    context: "roll",
    fallback: input.fallback,
  });
  if (!compiled.ok) {
    return { ok: false, expression: null, diagnostics: compiled.diagnostics };
  }
  const body = compiled.value;
  const scopedBindings: EvaluateExpressionBindings = {
    fields: pickBindings(input.bindings, input.env.fields),
    inputs: pickBindings(input.bindings, input.env.inputs),
  };
  const evaluated: EvalResult = evaluate(
    { id: "try_it", ...body } as CompiledExpressionV1,
    scopedBindings,
    input.rng,
  );
  const expression = renderExpression(body.ast);
  if (!evaluated.ok) {
    return { ok: false, expression, diagnostics: evaluated.diagnostics };
  }
  const rollDice: DieResult[] = evaluated.roll?.dice ?? [];
  return {
    ok: true,
    expression,
    ast: body.ast,
    value: evaluated.result,
    roll: evaluated.roll === null ? null : { total: evaluated.roll.total, dice: rollDice, expression: evaluated.roll.expression },
    diagnostics: evaluated.diagnostics,
  };
}
