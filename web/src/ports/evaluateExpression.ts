import {
  compileExpression,
  containsDice,
  evaluate,
  renderExpression,
  type CompiledExpressionV1,
  type EvalResult,
  type EvaluationBindings,
  type ExpressionAstV1,
  type Rng,
  type RollResult,
  type DieResult as SharedDieResult,
  type ScalarValue,
  type ValueType,
  type BindingValue,
  type FieldBindingType,
  type ExpressionCompileEnv,
} from "@sweetroll/rules";

export type { ScalarValue, ValueType, BindingValue, FieldBindingType };

export type ExpressionEnv = ExpressionCompileEnv;

export type EvaluateExpressionInput = {
  source: string;
  env: ExpressionEnv;
  resultType: ValueType;
  fallback: ScalarValue;
  bindings: Record<string, BindingValue>;
  itemBindings?: Record<string, BindingValue>;
  rng?: Rng;
  /** Where the expression is used. Computed fields and validations may be text or boolean; rolls must be numbers. */
  context?: "computed" | "roll" | "validation";
};

export type EvaluateDiagnostic = { code: string; path: string; message: string };

export type DieResult = SharedDieResult;

/** `EvaluationBindings` with its scopes populated from the flat binding map. */
type EvaluateExpressionBindings = EvaluationBindings;

function pickBindings(
  all: Record<string, BindingValue>,
  scope: Record<string, FieldBindingType>,
): Record<string, BindingValue> {
  const picked: Record<string, BindingValue> = {};
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
      roll: RollResult | null;
      diagnostics: EvaluateDiagnostic[];
    }
  | { ok: false; expression: string | null; diagnostics: EvaluateDiagnostic[] };

export function evaluateExpression(input: EvaluateExpressionInput): EvaluateExpressionResult {
  const compiled = compileExpression(input.source, {
    env: input.env,
    resultType: input.resultType,
    context: input.context ?? "roll",

    fallback: input.fallback,
  });
  if (!compiled.ok) {
    return { ok: false, expression: null, diagnostics: compiled.diagnostics };
  }
  const body = compiled.value;
  const scopedBindings: EvaluateExpressionBindings = {
    fields: pickBindings(input.bindings, input.env.fields),
    inputs: pickBindings(input.bindings, input.env.inputs),
    ...(input.env.item === undefined ? {} : { item: pickBindings(input.itemBindings ?? {}, input.env.item) }),
    ...(input.env.datasets === undefined ? {} : { datasets: input.env.datasets }),
    ...(input.env.slots === undefined ? {} : { slotEntries: () => [] }),
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
    roll: evaluated.roll === null ? null : {...evaluated.roll, dice: rollDice},
    diagnostics: evaluated.diagnostics,
  };
}


/** A flat dice sum only explains additive rolls; count/scale/negation need their own breakdown. */
export function additiveRollModifier(result: EvaluateExpressionResult): number | null {
  if (!result.ok || result.roll === null || result.diagnostics.length > 0) return null;
  function additive(ast: ExpressionAstV1): boolean {
    if (!containsDice(ast)) return true;
    switch (ast.kind) {
      case "pool":
        return ast.source.kind === "dice" && (!ast.reducer || ast.reducer.kind === "keepHighest" || ast.reducer.kind === "keepLowest");
      case "binary": return ast.operator === "+"
        ? additive(ast.left) && additive(ast.right)
        : ast.operator === "-" && additive(ast.left) && !containsDice(ast.right);
      default: return false;
    }
  }
  return additive(result.ast)
    ? result.roll.total - result.roll.dice.reduce((sum, die) => die.kept ? sum + die.value : sum, 0)
    : null;
}
