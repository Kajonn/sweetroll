import {
  tokenize,
  type RulesDiagnostic,
  type Token as RulesToken,
  type TokenizeResult as RulesTokenizeResult,
} from "@sweetroll/rules";

export type ExpressionDiagnostic = RulesDiagnostic;
export type Token = RulesToken;

export type TokenizeExpressionResult =
  | { ok: true; tokens: ReadonlyArray<Token> }
  | { ok: false; diagnostics: ReadonlyArray<ExpressionDiagnostic> };

/**
 * Live syntax check for the expression editors. Delegates to the real
 * grammar tokenizer (`@sweetroll/rules`, the same grammar v0.1 the server
 * enforces) so client diagnostics can never disagree with the server about
 * supported syntax such as dice notation. Never hand-roll a second
 * tokenizer here.
 */
export function tokenizeExpression(source: string): TokenizeExpressionResult {
  const result: RulesTokenizeResult = tokenize(source);
  if (result.ok) return { ok: true, tokens: result.tokens };
  return { ok: false, diagnostics: result.diagnostics };
}
