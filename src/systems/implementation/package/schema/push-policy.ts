import { Type, type Static } from "@sinclair/typebox";
import { DefinitionIdSchema } from "./common.js";
const Faces = Type.Array(Type.Integer({ minimum: 1, maximum: 1000 }), {
  maxItems: 1000,
  uniqueItems: true,
});
export const PushPolicySchema = Type.Object(
  {
    version: Type.Literal("1.0"),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
    successThreshold: Type.Number({ minimum: -1e9, maximum: 1e9 }),
    allowOnSuccess: Type.Boolean(),
    groups: Type.Array(
      Type.Object(
        {
          groupId: DefinitionIdSchema,
          lockedFaces: Faces,
          reportedFaces: Faces,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);
export type PushPolicy = Static<typeof PushPolicySchema>;
