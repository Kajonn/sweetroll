import { Type } from "@sinclair/typebox";

const uuid = Type.String({ format: "uuid" });

export const RollOptionsQuery = Type.Object({ entryId: Type.Optional(uuid) }, { additionalProperties: false });
export const RollOptionsSchema = Type.Object({
  targets: Type.Array(Type.Object({ characterId: uuid, name: Type.String() }), { maxItems: 100 }),
  rolls: Type.Array(Type.Object({ rollId: uuid, output: Type.String() }), { maxItems: 50 }),
});
