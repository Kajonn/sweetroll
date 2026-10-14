import { Type, type Static } from "@sinclair/typebox";

import { DefinitionIdSchema } from "./common.js";

// Template/slot schemas are defined in document.ts (next to the field union
// and action schemas they embed) to keep the schema import graph acyclic — a
// dynamic.ts <-> document.ts runtime import cycle throws "Cannot access
// before initialization" under native Node ESM (see Task 1 report). They are
// re-exported here as the canonical path for downstream tasks. The field
// union is imported once in document.ts and never redefined. CharacterEntryV1
// lives here: it only needs DefinitionIdSchema, so defining it here creates
// no cycle.
export {
  GrantedActionV1Schema,
  GrantedResourceBumpActionV1Schema,
  GrantedRollActionV1Schema,
  ObjectTemplateV1Schema,
  SlotDefinitionV1Schema,
  SlotSheetElementV1Schema,
  TemplateKindSchema,
} from "./document.js";
export type {
  GrantedActionV1,
  GrantedResourceBumpActionV1,
  GrantedRollActionV1,
  ObjectTemplateV1,
  SlotDefinitionV1,
  SlotSheetElementV1,
  TemplateKind,
} from "./document.js";

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const EntrySourceSchema = Type.Union([
  Type.Object({kind: Type.Literal("personal")}, {additionalProperties:false}),
  Type.Object({kind: Type.Literal("system"), templateId: DefinitionIdSchema}, {additionalProperties:false}),
  Type.Object({kind: Type.Literal("campaign"), campaignId: Type.String({format:"uuid"}), templateId: Type.String({format:"uuid"}), templateRevision:Type.Integer({minimum:1}), contentRevision:Type.Integer({minimum:1})}, {additionalProperties:false}),
]);
export type EntrySource = Static<typeof EntrySourceSchema>;
export const EntrySnapshotSchema = Type.Object({
  kind:Type.Union([Type.Literal("item"),Type.Literal("spell"),Type.Literal("talent"),Type.Literal("effect")]),
  values:Type.Record(Type.String(),Type.String()),
  quantity:Type.Optional(Type.Integer({minimum:1})),
}, {additionalProperties:false});
export type EntrySnapshot = Static<typeof EntrySnapshotSchema>;

export const CharacterEntryV1Schema = Type.Object(
  {
    entryId: Type.String({ pattern: UUID_PATTERN }),
    slotId: DefinitionIdSchema,
    templateId: Type.Union([DefinitionIdSchema, Type.Null()]),
    source: Type.Optional(EntrySourceSchema),
    snapshot: Type.Optional(EntrySnapshotSchema),
    values: Type.Record(Type.String(), Type.Unknown()),
    quantity: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type CharacterEntryV1 = Static<typeof CharacterEntryV1Schema>;
