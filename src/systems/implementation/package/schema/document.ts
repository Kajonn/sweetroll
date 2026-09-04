import { Type, type Static } from "@sinclair/typebox";

import { PACKAGE_LIMITS } from "../limits.js";
import { DefinitionIdSchema, ScalarValueSchema, ValueTypeSchema } from "./common.js";

const LABEL_MAX_LENGTH = 120;
const LONG_TEXT_MAX_LENGTH = 2_000;
const TEXT_MAX_LENGTH = 10_000;

const LabelSchema = Type.String({ maxLength: LABEL_MAX_LENGTH });
const TextSchema = Type.String({ maxLength: TEXT_MAX_LENGTH });

export const ChoiceOptionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
  },
  { additionalProperties: false },
);
export type ChoiceOptionV1 = Static<typeof ChoiceOptionV1Schema>;

export const TextFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("text"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    default: TextSchema,
    required: Type.Boolean(),
    minLength: Type.Number(),
    maxLength: Type.Number(),
  },
  { additionalProperties: false },
);
export type TextFieldV1 = Static<typeof TextFieldV1Schema>;

export const IntegerFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("integer"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    default: Type.Number(),
    required: Type.Boolean(),
    min: Type.Number(),
    max: Type.Number(),
    step: Type.Number(),
  },
  { additionalProperties: false },
);
export type IntegerFieldV1 = Static<typeof IntegerFieldV1Schema>;

export const DecimalFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("decimal"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    default: Type.Number(),
    required: Type.Boolean(),
    min: Type.Number(),
    max: Type.Number(),
    step: Type.Number(),
  },
  { additionalProperties: false },
);
export type DecimalFieldV1 = Static<typeof DecimalFieldV1Schema>;

export const BooleanFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("boolean"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    default: Type.Boolean(),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type BooleanFieldV1 = Static<typeof BooleanFieldV1Schema>;

export const SingleChoiceFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("singleChoice"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    required: Type.Boolean(),
    default: Type.Union([DefinitionIdSchema, Type.Null()]),
    options: Type.Array(ChoiceOptionV1Schema),
  },
  { additionalProperties: false },
);
export type SingleChoiceFieldV1 = Static<typeof SingleChoiceFieldV1Schema>;

export const MultiChoiceFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("multiChoice"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    required: Type.Boolean(),
    default: Type.Array(DefinitionIdSchema),
    options: Type.Array(ChoiceOptionV1Schema),
  },
  { additionalProperties: false },
);
export type MultiChoiceFieldV1 = Static<typeof MultiChoiceFieldV1Schema>;

export const ResourceValueV1Schema = Type.Object(
  {
    current: Type.Number(),
    max: Type.Number(),
  },
  { additionalProperties: false },
);
export type ResourceValueV1 = Static<typeof ResourceValueV1Schema>;

export const ResourceFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("resource"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    default: ResourceValueV1Schema,
    min: Type.Number(),
    max: Type.Number(),
    step: Type.Number(),
    resetTo: Type.Union([Type.Literal("min"), Type.Literal("max")]),
  },
  { additionalProperties: false },
);
export type ResourceFieldV1 = Static<typeof ResourceFieldV1Schema>;

export const ComputedFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("computed"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    valueType: ValueTypeSchema,
    expressionId: DefinitionIdSchema,
  },
  { additionalProperties: false },
);
export type ComputedFieldV1 = Static<typeof ComputedFieldV1Schema>;

export const ImageFieldV1Schema = Type.Object(
  {
    kind: Type.Literal("image"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ImageFieldV1 = Static<typeof ImageFieldV1Schema>;

export const FieldV1Schema = Type.Union([
  TextFieldV1Schema,
  IntegerFieldV1Schema,
  DecimalFieldV1Schema,
  BooleanFieldV1Schema,
  SingleChoiceFieldV1Schema,
  MultiChoiceFieldV1Schema,
  ResourceFieldV1Schema,
  ComputedFieldV1Schema,
  ImageFieldV1Schema,
]);
export type FieldV1 = Static<typeof FieldV1Schema>;

export const EntityDefinitionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    fields: Type.Array(FieldV1Schema, { maxItems: PACKAGE_LIMITS.fields }),
  },
  { additionalProperties: false },
);
export type EntityDefinitionV1 = Static<typeof EntityDefinitionV1Schema>;

export const ReferenceRecordV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    values: Type.Record(DefinitionIdSchema, ScalarValueSchema, {
      maxProperties: PACKAGE_LIMITS.referenceRecordValues,
    }),
  },
  { additionalProperties: false },
);
export type ReferenceRecordV1 = Static<typeof ReferenceRecordV1Schema>;

export const ReferenceDataV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    records: Type.Array(ReferenceRecordV1Schema, {
      maxItems: PACKAGE_LIMITS.referenceRecordsPerSet,
    }),
  },
  { additionalProperties: false },
);
export type ReferenceDataV1 = Static<typeof ReferenceDataV1Schema>;

export const HeadingSheetElementV1Schema = Type.Object(
  {
    kind: Type.Literal("heading"),
    id: DefinitionIdSchema,
    text: TextSchema,
    level: Type.Union([Type.Literal(2), Type.Literal(3)]),
  },
  { additionalProperties: false },
);
export type HeadingSheetElementV1 = Static<typeof HeadingSheetElementV1Schema>;

export const FieldSheetElementV1Schema = Type.Object(
  {
    kind: Type.Literal("field"),
    id: DefinitionIdSchema,
    fieldId: DefinitionIdSchema,
  },
  { additionalProperties: false },
);
export type FieldSheetElementV1 = Static<typeof FieldSheetElementV1Schema>;

export const ResourceSheetElementV1Schema = Type.Object(
  {
    kind: Type.Literal("resource"),
    id: DefinitionIdSchema,
    resourceId: DefinitionIdSchema,
  },
  { additionalProperties: false },
);
export type ResourceSheetElementV1 = Static<typeof ResourceSheetElementV1Schema>;

export const ActionSheetElementV1Schema = Type.Object(
  {
    kind: Type.Literal("action"),
    id: DefinitionIdSchema,
    actionId: DefinitionIdSchema,
  },
  { additionalProperties: false },
);
export type ActionSheetElementV1 = Static<typeof ActionSheetElementV1Schema>;

export const SheetElementV1Schema = Type.Union([
  HeadingSheetElementV1Schema,
  FieldSheetElementV1Schema,
  ResourceSheetElementV1Schema,
  ActionSheetElementV1Schema,
]);
export type SheetElementV1 = Static<typeof SheetElementV1Schema>;

export const SheetSectionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    elements: Type.Array(SheetElementV1Schema, { maxItems: PACKAGE_LIMITS.sheetElements }),
  },
  { additionalProperties: false },
);
export type SheetSectionV1 = Static<typeof SheetSectionV1Schema>;

export const SheetV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    targetEntityId: DefinitionIdSchema,
    sections: Type.Array(SheetSectionV1Schema, {
      maxItems: PACKAGE_LIMITS.sectionsPerSheet,
    }),
  },
  { additionalProperties: false },
);
export type SheetV1 = Static<typeof SheetV1Schema>;

export const SourceExpressionV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    context: Type.Union([
      Type.Literal("computed"),
      Type.Literal("roll"),
      Type.Literal("validation"),
    ]),
    resultType: ValueTypeSchema,
    source: Type.String({ maxLength: PACKAGE_LIMITS.expressionBytes }),
    fallback: ScalarValueSchema,
  },
  { additionalProperties: false },
);
export type SourceExpressionV1 = Static<typeof SourceExpressionV1Schema>;

export const ActionInputV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    label: LabelSchema,
    valueType: Type.Union([
      Type.Literal("integer"),
      Type.Literal("decimal"),
      Type.Literal("boolean"),
      Type.Literal("text"),
    ]),
    required: Type.Boolean(),
    default: ScalarValueSchema,
  },
  { additionalProperties: false },
);
export type ActionInputV1 = Static<typeof ActionInputV1Schema>;

export const RollActionV1Schema = Type.Object(
  {
    kind: Type.Literal("roll"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    expressionId: DefinitionIdSchema,
    inputs: Type.Array(ActionInputV1Schema),
    outputTemplate: Type.String({ maxLength: LONG_TEXT_MAX_LENGTH }),
  },
  { additionalProperties: false },
);
export type RollActionV1 = Static<typeof RollActionV1Schema>;

export const ResourceDeltaOperationV1Schema = Type.Object(
  {
    kind: Type.Literal("delta"),
    amount: Type.Number(),
  },
  { additionalProperties: false },
);
export type ResourceDeltaOperationV1 = Static<typeof ResourceDeltaOperationV1Schema>;

export const ResourceResetOperationV1Schema = Type.Object(
  { kind: Type.Literal("reset") },
  { additionalProperties: false },
);
export type ResourceResetOperationV1 = Static<typeof ResourceResetOperationV1Schema>;

export const ResourceBumpActionV1Schema = Type.Object(
  {
    kind: Type.Literal("resourceBump"),
    id: DefinitionIdSchema,
    label: LabelSchema,
    resourceId: DefinitionIdSchema,
    operation: Type.Union([
      ResourceDeltaOperationV1Schema,
      ResourceResetOperationV1Schema,
    ]),
  },
  { additionalProperties: false },
);
export type ResourceBumpActionV1 = Static<typeof ResourceBumpActionV1Schema>;

export const ActionV1Schema = Type.Union([RollActionV1Schema, ResourceBumpActionV1Schema]);
export type ActionV1 = Static<typeof ActionV1Schema>;

export const ValidationV1Schema = Type.Object(
  {
    id: DefinitionIdSchema,
    expressionId: DefinitionIdSchema,
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
    message: Type.String({ maxLength: LONG_TEXT_MAX_LENGTH }),
    targetId: DefinitionIdSchema,
  },
  { additionalProperties: false },
);
export type ValidationV1 = Static<typeof ValidationV1Schema>;

export const SystemMetadataV1Schema = Type.Object(
  {
    name: LabelSchema,
    description: Type.String({ maxLength: LONG_TEXT_MAX_LENGTH }),
    language: TextSchema,
    defaultDice: TextSchema,
  },
  { additionalProperties: false },
);
export type SystemMetadataV1 = Static<typeof SystemMetadataV1Schema>;

export const SystemDocumentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    metadata: SystemMetadataV1Schema,
    entities: Type.Array(EntityDefinitionV1Schema, { maxItems: PACKAGE_LIMITS.entities }),
    referenceData: Type.Array(ReferenceDataV1Schema, {
      maxItems: PACKAGE_LIMITS.referenceDataSets,
    }),
    sheets: Type.Array(SheetV1Schema, { maxItems: PACKAGE_LIMITS.sheets }),
    expressions: Type.Array(SourceExpressionV1Schema, {
      maxItems: PACKAGE_LIMITS.expressions,
    }),
    actions: Type.Array(ActionV1Schema, { maxItems: PACKAGE_LIMITS.actions }),
    validations: Type.Array(ValidationV1Schema, {
      maxItems: PACKAGE_LIMITS.validations,
    }),
  },
  { additionalProperties: false },
);
export type SystemDocumentV1 = Static<typeof SystemDocumentV1Schema>;
