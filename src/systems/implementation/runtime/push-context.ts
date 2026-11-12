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
    // Design 6.8: origin of `expressionId` and `entry.templateId` when they
    // come from an extension, and the composition the roll was made under.
    extensionId: Type.Optional(Type.String({
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    })),
    compositionChecksum: Type.Optional(Type.String({ maxLength: 80 })),
    outputTemplate: Type.String({ maxLength: 2000 }),
    // A 2,000-character template can contain at most 250 scoped placeholders.
    outputValues: Type.Optional(Type.Record(
      Type.String({ pattern: "^(fields|inputs|item)\\.[a-z][a-z0-9_]{0,63}(\\.(current|max))?$" }),
      Type.String(),
      { additionalProperties: false, maxProperties: 250 },
    )),
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
