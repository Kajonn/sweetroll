import { Type, type Static } from "@sinclair/typebox";

export const DefinitionIdSchema = Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" });
export type DefinitionId = Static<typeof DefinitionIdSchema>;

export const ScalarValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export type ScalarValue = Static<typeof ScalarValueSchema>;

export const ValueTypeSchema = Type.Union([
  Type.Literal("number"),
  Type.Literal("text"),
  Type.Literal("boolean"),
]);
export type ValueType = Static<typeof ValueTypeSchema>;
