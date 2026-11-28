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

/** Design 6.1 (SRD gaps S2): the reference tables of a system, readable by everyone who may use it. */
export const ReferenceDataListSchema = Type.Array(Type.Object({
  datasetId: Type.String(),
  label: Type.String(),
  records: Type.Integer({ minimum: 0, maximum: 1000 }),
}), { maxItems: 64 });
export const ReferenceDatasetSchema = Type.Object({
  datasetId: Type.String(),
  label: Type.String(),
  records: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.String(),
    values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
  }), { maxItems: 1000 }),
});

/** Design 6.3 (S6): saved rolls the reader may apply to a resource of this character. */
export const ApplicableRollsSchema = Type.Array(Type.Object({
  rollId: Type.String(),
  output: Type.String(),
  total: Type.Number(),
}), { maxItems: 20 });
