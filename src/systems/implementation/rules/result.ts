import { Type, type Static } from "@sinclair/typebox";
import { ScalarValueSchema, DefinitionIdSchema } from "../package/schema/common.js";
import { PACKAGE_LIMITS } from "../package/limits.js";

export const BindingValueSchema = Type.Union([ScalarValueSchema, Type.Array(DefinitionIdSchema, { uniqueItems: true })]);

const Identity = Type.String({ minLength: 1, maxLength: 256 });
export const DieResultSchema = Type.Object(
  {
    sides: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.sidesPerDie }),
    value: Type.Integer({ minimum: 1 }),
    kept: Type.Boolean(),
    id: Type.Optional(Identity),
    groupId: Type.Optional(Identity),
    success: Type.Optional(Type.Boolean()),
    rerolledFrom: Type.Optional(Identity),
    explodedFrom: Type.Optional(Identity),
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
            Type.Literal("countAtLeast"),
            Type.Literal("countAtMost"),
            Type.Literal("countEqual"),
            Type.Literal("keepHighest"),
            Type.Literal("keepLowest"),
          ]),
          threshold: Type.Optional(Type.Integer()),
          keepCount: Type.Optional(Type.Integer({ minimum: 0, maximum: PACKAGE_LIMITS.dicePerRoll })),
          modifiers: Type.Optional(Type.Array(Type.Union([Type.Literal("explode"), Type.Literal("rerollOnce")]), { maxItems: 2, uniqueItems: true })),
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
          operandIds: Type.Array(Identity, { maxItems: 8 }),
          value: BindingValueSchema,
          groupId: Type.Optional(Identity),
          reused: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
      { maxItems: PACKAGE_LIMITS.expressionAstNodes },
    ),
  },
  { additionalProperties: false },
);
export type RollBreakdown = Static<typeof RollBreakdownSchema>;

/** Plain-text dice details for campaign exports alongside the structured graph. */
export function formatRollBreakdown(breakdown: RollBreakdown, dice: readonly DieResult[]): string {
  const byId = new Map(dice.map((die) => [die.id, die]));
  const lines = breakdown.groups.map((group) => {
    const parameter = group.keepCount ?? group.threshold;
    const operation = parameter === undefined ? group.operation : `${group.operation} ${parameter}`;
    const faces = group.diceIds.map((id) => {
      const die = byId.get(id)!;
      const parentId = die.rerolledFrom ?? die.explodedFrom;
      const source = parentId === undefined ? "" :
        die.rerolledFrom ? ` (rerolled from ${byId.get(parentId)?.value})` : ` (explosion after ${byId.get(parentId)?.value})`;
      return `d${die.sides}=${die.value}${source}${die.kept ? "" : " (discarded)"}`;
    });
    return `${group.label} (${group.count}d${group.sides}, ${operation}): ${group.total}${faces.length ? ` [${faces.join(", ")}]` : ""}`;
  });
  const groups = new Map(breakdown.groups.map((group) => [group.id, group.label]));
  for (const term of breakdown.terms) {
    if (term.reused && term.groupId) lines.push(`Reused ${groups.get(term.groupId)} (${term.operation}): ${String(term.value)}`);
  }
  const root = breakdown.terms.find((term) => term.id === breakdown.rootId);
  if (root) lines.push(`Total: ${String(root.value)}`);
  return lines.join("\n");
}

export const PushResultSchema=Type.Object({
 version:Type.Literal("1.0"),rollId:Type.String({pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}),rootRollId:Type.String({pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}),parentRollId:Type.Union([Type.String({pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}),Type.Null()]),attempt:Type.Integer({minimum:0,maximum:10}),maxAttempts:Type.Integer({minimum:1,maximum:10}),rerolledDiceIds:Type.Array(Identity,{maxItems:100,uniqueItems:true}),
 faceOutcomes:Type.Array(Type.Object({groupId:Identity,face:Type.Integer({minimum:1,maximum:1000}),combinedCount:Type.Integer({minimum:0,maximum:100}),rerolledCount:Type.Integer({minimum:0,maximum:100})},{additionalProperties:false}),{maxItems:32000})
},{additionalProperties:false});
export type PushResult=Static<typeof PushResultSchema>;

/** Complete public outcome required before a durable push can be acknowledged. */
export const SavedPushRollSchema = Type.Object({
  actionId: Type.String({ minLength: 1 }), expression: Type.String({ minLength: 1 }),
  dice: Type.Array(DieResultSchema, { maxItems: 100 }),
  bindings: Type.Array(Type.Object({scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs"), Type.Literal("item"), Type.Literal("aggregates")]), definitionId: Type.String({minLength:1}), value: BindingValueSchema}), {maxItems:256}),
  total: Type.Number(), output: Type.String(),
  audience: Type.Union([Type.Literal("owner_only"),Type.Literal("gm_only"),Type.Literal("campaign")]),
  breakdown: RollBreakdownSchema, push: PushResultSchema,
});
