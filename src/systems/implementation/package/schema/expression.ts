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
          scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs")]),
          id: DefinitionIdSchema,
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
          ]),
          arguments: Type.Array(ExpressionAstV1, { maxItems: 2 }),
          roundMode: Type.Optional(
            Type.Union([Type.Literal("nearest"), Type.Literal("down"), Type.Literal("up")]),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("dice"),
          count: ExpressionAstV1,
          sides: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.sidesPerDie }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("keep"),
          mode: Type.Union([Type.Literal("highest"), Type.Literal("lowest")]),
          count: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.dicePerRoll }),
          dice: ExpressionAstV1,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("successCount"),
          dice: ExpressionAstV1,
          threshold: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ]),
  { $id: "ExpressionAstV1" },
);
export type ExpressionAstV1 = Static<typeof ExpressionAstV1Schema>;

export const CompiledExpressionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    context: Type.Union([
      Type.Literal("computed"),
      Type.Literal("roll"),
      Type.Literal("validation"),
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
