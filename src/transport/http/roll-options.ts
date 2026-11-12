import { Type } from "@sinclair/typebox";

const uuid = Type.String({ format: "uuid" });

export const RollOptionsQuery = Type.Object({ entryId: Type.Optional(uuid) }, { additionalProperties: false });
export const RollOptionsSchema = Type.Object({
  targets: Type.Array(Type.Object({ characterId: uuid, name: Type.String() }), { maxItems: 100 }),
  rolls: Type.Array(Type.Object({ rollId: uuid, output: Type.String() }), { maxItems: 50 }),
});

/** Design 6.4 (C13): card counts of the decks a character's system defines. */
export const CharacterDecksSchema = Type.Array(Type.Object({
  deckId: Type.String(),
  label: Type.String(),
  total: Type.Integer({ minimum: 1, maximum: 200 }),
  remaining: Type.Integer({ minimum: 0, maximum: 200 }),
}), { maxItems: 4 });
