import { tokenize } from "./tokenizer-impl.js";
import type { ExpressionDiagnostic, Token } from "./tokenizer-impl.js";

export type { ExpressionDiagnostic, Token };

export type TokenizeExpressionResult =
  | { ok: true; tokens: ReadonlyArray<Token> }
  | { ok: false; diagnostics: ReadonlyArray<ExpressionDiagnostic> };

export function tokenizeExpression(source: string): TokenizeExpressionResult {
  return tokenize(source);
}
