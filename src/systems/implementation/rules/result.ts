import { Type, type Static } from "@sinclair/typebox";
import { ScalarValueSchema } from "../package/schema/common.js";
import { PACKAGE_LIMITS } from "../package/limits.js";

const Identity = Type.String({ minLength: 1, maxLength: 256 });
export const DieResultSchema = Type.Object(
  {
    sides: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.sidesPerDie }),
    value: Type.Integer({ minimum: 1 }),
    kept: Type.Boolean(),
    id: Type.Optional(Identity),
    groupId: Type.Optional(Identity),
    success: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DieResult = Static<typeof DieResultSchema>;
export const RollBreakdownSchema = Type.Object(
  {
    version: Type.Literal("1.0"),
    rootId: Identity,
    groups: Type.Array(
      Type.Object(
        {
          id: Identity,
          label: Type.String({ minLength: 1, maxLength: 120 }),
          count: Type.Integer({
            minimum: 0,
            maximum: PACKAGE_LIMITS.dicePerRoll,
          }),
          sides: Type.Integer({
            minimum: 1,
            maximum: PACKAGE_LIMITS.sidesPerDie,
          }),
          operation: Type.Union([
            Type.Literal("sum"),
            Type.Literal("successCount"),
            Type.Literal("keepHighest"),
            Type.Literal("keepLowest"),
          ]),
          threshold: Type.Optional(Type.Integer()),
          diceIds: Type.Array(Identity, {
            maxItems: PACKAGE_LIMITS.dicePerRoll,
          }),
          total: Type.Number(),
        },
        { additionalProperties: false },
      ),
      { maxItems: PACKAGE_LIMITS.expressionAstNodes },
    ),
    terms: Type.Array(
      Type.Object(
        {
          id: Identity,
          operation: Type.String({ minLength: 1, maxLength: 32 }),
          operandIds: Type.Array(Identity, { maxItems: 2 }),
          value: ScalarValueSchema,
          groupId: Type.Optional(Identity),
        },
        { additionalProperties: false },
      ),
      { maxItems: PACKAGE_LIMITS.expressionAstNodes },
    ),
  },
  { additionalProperties: false },
);
export type RollBreakdown = Static<typeof RollBreakdownSchema>;
