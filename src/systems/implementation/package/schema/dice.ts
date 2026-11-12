import { Type, type Static } from "@sinclair/typebox";

import { PACKAGE_LIMITS } from "../limits.js";
import { DefinitionIdSchema } from "./common.js";

export const FaceLabelSchema = Type.String({ minLength: 1, maxLength: 120 });
export const FaceSymbolsSchema = Type.Record(DefinitionIdSchema, Type.Integer({ minimum: 1, maximum: PACKAGE_LIMITS.symbolCountPerFace }), {
  maxProperties: PACKAGE_LIMITS.symbolsPerFace,
  additionalProperties: false,
});

export const CustomDieSchema = Type.Object({
  id: DefinitionIdSchema,
  label: FaceLabelSchema,
  faces: Type.Array(Type.Object({
    value: Type.Number(),
    label: Type.Optional(FaceLabelSchema),
    symbols: Type.Optional(FaceSymbolsSchema),
  }, { additionalProperties: false }), { minItems: 1, maxItems: PACKAGE_LIMITS.facesPerCustomDie }),
}, { additionalProperties: false });

export type CustomDie = Static<typeof CustomDieSchema>;
