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


/** A flat dice sum only explains additive rolls; count/scale/negation need their own breakdown. */
export function additiveRollModifier(result: EvaluateExpressionResult): number | null {
  if (!result.ok || result.roll === null || result.diagnostics.length > 0) return null;
  function diceFree(ast: ExpressionAstV1): boolean {
    switch (ast.kind) {
      case "dice": case "keep": case "successCount": return false;
      case "binary": return diceFree(ast.left) && diceFree(ast.right);
      case "unary": return diceFree(ast.operand);
      case "call": return ast.arguments.every(diceFree);
      default: return true;
    }
  }
  function additive(ast: ExpressionAstV1): boolean {
    if (diceFree(ast)) return true;
    switch (ast.kind) {
      case "dice": return diceFree(ast.count);
      case "keep": return ast.dice.kind === "dice" && diceFree(ast.dice.count);
      case "binary": return ast.operator === "+"
        ? additive(ast.left) && additive(ast.right)
        : ast.operator === "-" && additive(ast.left) && diceFree(ast.right);
      default: return false;
    }
  }
  return additive(result.ast)
    ? result.roll.total - result.roll.dice.reduce((sum, die) => die.kept ? sum + die.value : sum, 0)
    : null;
}
