import { Type, type Static } from "@sinclair/typebox";

import { PACKAGE_LIMITS } from "../limits.js";
import { DefinitionIdSchema, ScalarValueSchema, ValueTypeSchema } from "./common.js";

export const ExpressionAstV1Schema = Type.Recursive(
  (ExpressionAstV1) =>
    Type.Union([
      Type.Object(
        {
          kind: Type.Literal("numberLiteral"),
          value: Type.Number(),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("stringLiteral"),
          value: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("booleanLiteral"),
          value: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("reference"),
          scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs"), Type.Literal("item"), Type.Literal("roll")]),
          id: DefinitionIdSchema,
          part: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("max")])),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("unary"),
          operator: Type.Union([Type.Literal("-"), Type.Literal("!")]),
          operand: ExpressionAstV1,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("binary"),
          operator: Type.Union([
            Type.Literal("+"),
            Type.Literal("-"),
            Type.Literal("*"),
            Type.Literal("/"),
            Type.Literal("%"),
            Type.Literal("=="),
            Type.Literal("!="),
            Type.Literal("<"),
            Type.Literal("<="),
            Type.Literal(">"),
            Type.Literal(">="),
            Type.Literal("&&"),
            Type.Literal("||"),
          ]),
          left: ExpressionAstV1,
          right: ExpressionAstV1,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("call"),
          function: Type.Union([
            Type.Literal("min"),
            Type.Literal("max"),
            Type.Literal("round"),
            Type.Literal("floor"),
            Type.Literal("ceil"),
            Type.Literal("abs"),
            Type.Literal("if"),
            Type.Literal("has"),
            Type.Literal("lookup"),
            Type.Literal("lookupBand"),
            Type.Literal("sum"),
            Type.Literal("count"),
            Type.Literal("sumWhere"),
            Type.Literal("countWhere"),
            Type.Literal("maxOf"),
          ]),
          arguments: Type.Array(ExpressionAstV1, { maxItems: 8 }),
          roundMode: Type.Optional(
            Type.Union([Type.Literal("nearest"), Type.Literal("down"), Type.Literal("up")]),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("pool"),
          source: Type.Union([
            Type.Object({ kind: Type.Literal("dice"), count: ExpressionAstV1, sides: ExpressionAstV1 }, { additionalProperties: false }),
            Type.Object({ kind: Type.Literal("custom"), count: ExpressionAstV1, dieId: DefinitionIdSchema }, { additionalProperties: false }),
            Type.Object({ kind: Type.Literal("rolled"), groupId: DefinitionIdSchema }, { additionalProperties: false }),
          ]),
          group: Type.Optional(Type.Object({
            id: DefinitionIdSchema,
            label: Type.String({ minLength: 1, maxLength: 120 }),
          }, { additionalProperties: false })),
          modifiers: Type.Array(Type.Union([
            Type.Object({ kind: Type.Literal("explode"), face: Type.Optional(ExpressionAstV1) }, { additionalProperties: false }),
            Type.Object({ kind: Type.Literal("rerollOnce"), face: ExpressionAstV1 }, { additionalProperties: false }),
          ]), { maxItems: 2 }),
          reducer: Type.Optional(Type.Union([Type.Object({
            kind: Type.Union([
              Type.Literal("keepHighest"), Type.Literal("keepLowest"),
              Type.Literal("countAtLeast"), Type.Literal("countAtMost"), Type.Literal("countEqual"),
            ]),
            amount: ExpressionAstV1,
          }, { additionalProperties: false }), Type.Object({
            kind: Type.Literal("countSymbol"),
            symbol: DefinitionIdSchema,
          }, { additionalProperties: false })])),
        },
        { additionalProperties: false },
      ),
    ]),
  { $id: "ExpressionAstV1" },
);
export type ExpressionAstV1 = Static<typeof ExpressionAstV1Schema>;
export type PoolAst = Extract<ExpressionAstV1, { kind: "pool" }>;

export const CompiledExpressionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    languageVersion: Type.Literal("1.0"),
    context: Type.Union([
      Type.Literal("computed"),
      Type.Literal("roll"),
      Type.Literal("validation"),
      Type.Literal("outcome"),
    ]),
    resultType: ValueTypeSchema,
    inferredType: ValueTypeSchema,
    fallback: ScalarValueSchema,
    dependencies: Type.Array(DefinitionIdSchema, { maxItems: PACKAGE_LIMITS.expressions }),
    cost: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.expressionAstNodes }),
    ast: ExpressionAstV1Schema,
  },
  { additionalProperties: false },
);
export type CompiledExpressionV1 = Static<typeof CompiledExpressionV1Schema>;
