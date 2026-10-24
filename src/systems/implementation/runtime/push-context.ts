import { Type, type Static } from "@sinclair/typebox";
import { PushPolicySchema } from "../package/schema/push-policy.js";
import { EntrySourceSchema } from "../package/schema/dynamic.js";
export const PushContextSchema = Type.Object(
  {
    version: Type.Literal("1.0"),
    versionId: Type.String({
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    }),
    packageChecksum: Type.String({ maxLength: 80 }),
    entityId: Type.String({ maxLength: 64 }),
    expressionId: Type.String({ maxLength: 64 }),
    outputTemplate: Type.String({ maxLength: 2000 }),
    policy: PushPolicySchema,
    entry: Type.Optional(
      Type.Object(
        {
          entryId: Type.String({
            pattern:
              "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
          }),
          templateId: Type.String({ maxLength: 64 }),
          slotId: Type.String({ maxLength: 64 }),
          source: Type.Optional(EntrySourceSchema),
        },
        { additionalProperties: false },
      ),
    ),
    scope: Type.Optional(
      Type.Object(
        {
          ownerId: Type.Union([
            Type.String({
              pattern:
                "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            }),
            Type.Null(),
          ]),
          campaignId: Type.Union([
            Type.String({
              pattern:
                "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            }),
            Type.Null(),
          ]),
          placementGeneration: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PushContext = Static<typeof PushContextSchema>;
