import { Type, type Static } from "@sinclair/typebox";

import { PACKAGE_LIMITS } from "../limits.js";
import {
  ObjectTemplateV1Schema,
  SourceExpressionV1Schema,
} from "./document.js";
import { CompiledExpressionV1Schema } from "./expression.js";
import { EffectivePackageLimitsV1Schema } from "./package.js";

// System extensions (design Section 6.8, plan 2026-11-07-system-extensions,
// decision X1): an extension adds templates (item, spell, talent, effect) to
// one system, plus the computed/roll expressions those templates use. It never
// adds character fields, entities, sheets, slots, entity actions or
// validations. Its own format version is independent of the system package
// version; extension expressions always use grammar 0.2 and push policies.

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SEMANTIC_VERSION_PATTERN =
  "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$";
const CHECKSUM_PATTERN = "^sha256:[0-9a-f]{64}$";

const UuidSchema = Type.String({ pattern: UUID_PATTERN });

export const ExtensionMetadataV1Schema = Type.Object(
  {
    name: Type.String({ maxLength: 120 }),
    description: Type.String({ maxLength: 2_000 }),
    language: Type.String({ maxLength: 10_000 }),
  },
  { additionalProperties: false },
);
export type ExtensionMetadataV1 = Static<typeof ExtensionMetadataV1Schema>;

export const ExtensionDocumentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    metadata: ExtensionMetadataV1Schema,
    expressions: Type.Array(SourceExpressionV1Schema, {
      maxItems: PACKAGE_LIMITS.expressions,
    }),
    templates: Type.Array(ObjectTemplateV1Schema, { maxItems: PACKAGE_LIMITS.templates }),
  },
  { additionalProperties: false },
);
export type ExtensionDocumentV1 = Static<typeof ExtensionDocumentV1Schema>;

export const ExtensionPackageV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    extensionId: UuidSchema,
    versionId: UuidSchema,
    semanticVersion: Type.String({ pattern: SEMANTIC_VERSION_PATTERN }),
    baseSystemId: UuidSchema,
    builtAgainstVersionId: UuidSchema,
    ...ExtensionMetadataV1Schema.properties,
    expressions: Type.Array(CompiledExpressionV1Schema, {
      maxItems: PACKAGE_LIMITS.expressions,
    }),
    templates: Type.Array(ObjectTemplateV1Schema, { maxItems: PACKAGE_LIMITS.templates }),
    effectiveLimits: EffectivePackageLimitsV1Schema,
    integrity: Type.Object(
      { checksum: Type.String({ pattern: CHECKSUM_PATTERN }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ExtensionPackageV1 = Static<typeof ExtensionPackageV1Schema>;
export type UnsignedExtensionPackageV1 = Omit<ExtensionPackageV1, "integrity">;
