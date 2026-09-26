import { Type, type Static } from "@sinclair/typebox";

import { PACKAGE_LIMITS } from "../limits.js";
import {
  ActionV1Schema,
  EntityDefinitionV1Schema,
  ReferenceDataV1Schema,
  SheetV1Schema,
  SystemMetadataV1Schema,
  ValidationV1Schema,
} from "./document.js";
import { ObjectTemplateV1Schema, SlotDefinitionV1Schema } from "./dynamic.js";
import { CompiledExpressionV1Schema } from "./expression.js";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SEMANTIC_VERSION_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$";
const CHECKSUM_PATTERN = "^sha256:[0-9a-f]{64}$";

export const EffectivePackageLimitsV1Schema = Type.Object(
  {
    expressionBytes: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.expressionBytes }),
    expressionAstNodes: Type.Integer({
      minimum: 1,
      maximum: PACKAGE_LIMITS.expressionAstNodes,
    }),
    expressionAstDepth: Type.Integer({
      minimum: 1,
      maximum: PACKAGE_LIMITS.expressionAstDepth,
    }),
    dicePerRoll: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.dicePerRoll }),
    sidesPerDie: Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.sidesPerDie }),
  },
  { additionalProperties: false },
);
export type EffectivePackageLimitsV1 = Static<typeof EffectivePackageLimitsV1Schema>;

export const SystemPackageV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    systemId: Type.String({ pattern: UUID_PATTERN }),
    versionId: Type.String({ pattern: UUID_PATTERN }),
    semanticVersion: Type.String({ pattern: SEMANTIC_VERSION_PATTERN }),
    ...SystemMetadataV1Schema.properties,
    entities: Type.Array(EntityDefinitionV1Schema, { maxItems: PACKAGE_LIMITS.entities }),
    referenceData: Type.Array(ReferenceDataV1Schema, {
      maxItems: PACKAGE_LIMITS.referenceDataSets,
    }),
    sheets: Type.Array(SheetV1Schema, { maxItems: PACKAGE_LIMITS.sheets }),
    expressions: Type.Array(CompiledExpressionV1Schema, {
      maxItems: PACKAGE_LIMITS.expressions,
    }),
    actions: Type.Array(ActionV1Schema, { maxItems: PACKAGE_LIMITS.actions }),
    validations: Type.Array(ValidationV1Schema, { maxItems: PACKAGE_LIMITS.validations }),
    templates: Type.Optional(Type.Array(ObjectTemplateV1Schema, { maxItems: 128 })),
    slots: Type.Optional(Type.Array(SlotDefinitionV1Schema, { maxItems: 64 })),
    effectiveLimits: EffectivePackageLimitsV1Schema,
    integrity: Type.Object(
      {
        checksum: Type.String({ pattern: CHECKSUM_PATTERN }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type SystemPackageV1 = Static<typeof SystemPackageV1Schema>;
export type UnsignedSystemPackageV1 = Omit<SystemPackageV1, "integrity">;
