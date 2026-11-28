import { Type, type Static } from "@sinclair/typebox";
import { ScalarValueSchema, DefinitionIdSchema } from "../package/schema/common.js";
import { FaceLabelSchema, FaceSymbolsSchema } from "../package/schema/dice.js";
import { PACKAGE_LIMITS } from "../package/limits.js";

export const BindingValueSchema = Type.Union([ScalarValueSchema, Type.Array(DefinitionIdSchema, { uniqueItems: true })]);

const Identity = Type.String({ minLength: 1, maxLength: 256 });
export const DieResultSchema = Type.Object(
  {
    sides: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.sidesPerDie }),
    value: Type.Number(),
    faceLabel: Type.Optional(FaceLabelSchema),
    symbols: Type.Optional(FaceSymbolsSchema),
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
/** Design 6.4 (C13): the cards one draw took from a deck, in the order drawn. */
export const DrawnCardsSchema = Type.Object(
  {
    deckId: DefinitionIdSchema,
    deckLabel: Type.String({ maxLength: 120 }),
    /** Cards left in the deck after this draw. */
    remaining: Type.Integer({ minimum: 0, maximum: PACKAGE_LIMITS.cardsPerDeck }),
    drawn: Type.Array(
      Type.Object(
        {
          id: DefinitionIdSchema,
          label: Type.String({ maxLength: 120 }),
          values: Type.Record(DefinitionIdSchema, ScalarValueSchema, {
            additionalProperties: false,
            maxProperties: PACKAGE_LIMITS.referenceRecordValues,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: PACKAGE_LIMITS.cardsPerDraw },
    ),
  },
  { additionalProperties: false },
);
export type DrawnCards = Static<typeof DrawnCardsSchema>;

export function formatCard(card: DrawnCards["drawn"][number]): string {
  const values = Object.entries(card.values).map(([id, value]) => `${id}: ${String(value)}`);
  return values.length === 0 ? card.label : `${card.label} (${values.join(", ")})`;
}

export const RollBreakdownSchema = Type.Object(
  {
    version: Type.Literal("1.0"),
    rootId: Identity,
    cards: Type.Optional(DrawnCardsSchema),
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
          dieId: Type.Optional(DefinitionIdSchema),
          symbol: Type.Optional(DefinitionIdSchema),
          operation: Type.Union([
            Type.Literal("sum"),
            Type.Literal("countAtLeast"),
            Type.Literal("countAtMost"),
            Type.Literal("countEqual"),
            Type.Literal("countSymbol"),
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
          symbol: Type.Optional(DefinitionIdSchema),
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

export function formatDieFace(die: DieResult): string {
  const value = die.faceLabel === undefined ? String(die.value) : `${die.faceLabel} (${die.value})`;
  const symbols = Object.entries(die.symbols ?? {}).map(([id, count]) => `${id} × ${count}`);
  return symbols.length === 0 ? value : `${value}, ${symbols.join(", ")}`;
}

/** Plain-text dice details for campaign exports alongside the structured graph. */
export function formatRollBreakdown(breakdown: RollBreakdown, dice: readonly DieResult[]): string {
  const byId = new Map(dice.map((die) => [die.id, die]));
  const face = (id: string) => {
    const die = byId.get(id);
    return die === undefined ? "?" : formatDieFace(die);
  };
  const lines = breakdown.groups.map((group) => {
    const parameter = group.symbol ?? group.keepCount ?? group.threshold;
    const operation = parameter === undefined ? group.operation : `${group.operation} ${parameter}`;
    const faces = group.diceIds.map((id) => {
      const die = byId.get(id)!;
      const parentId = die.rerolledFrom ?? die.explodedFrom;
      const source = parentId === undefined ? "" :
        die.rerolledFrom ? ` (rerolled from ${face(parentId)})` : ` (explosion after ${face(parentId)})`;
      return `d${die.sides}=${formatDieFace(die)}${source}${die.kept ? "" : " (discarded)"}`;
    });
    const source = group.dieId ? `${group.count} × ${group.dieId}` : `${group.count}d${group.sides}`;
    return `${group.label} (${source}, ${operation}): ${group.total}${faces.length ? ` [${faces.join(", ")}]` : ""}`;
  });
  const groups = new Map(breakdown.groups.map((group) => [group.id, group.label]));
  for (const term of breakdown.terms) {
    if (term.reused && term.groupId) lines.push(`Reused ${groups.get(term.groupId)} (${term.operation}${term.symbol ? ` ${term.symbol}` : ""}): ${String(term.value)}`);
  }
  if (breakdown.cards) {
    const { deckLabel, drawn, remaining } = breakdown.cards;
    return [...drawn.map((card, index) => `${deckLabel} ${index + 1}: ${formatCard(card)}`), `Cards left: ${remaining}`].join("\n");
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
  bindings: Type.Array(Type.Object({scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs"), Type.Literal("item"), Type.Literal("aggregates"), Type.Literal("target"), Type.Literal("opposed")]), definitionId: Type.String({minLength:1}), value: BindingValueSchema}), {maxItems:256}),
  total: Type.Number(), output: Type.String(),
  audience: Type.Union([Type.Literal("owner_only"),Type.Literal("gm_only"),Type.Literal("campaign")]),
  breakdown: RollBreakdownSchema, push: PushResultSchema,
});
