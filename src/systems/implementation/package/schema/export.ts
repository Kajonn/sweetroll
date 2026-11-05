import { Type, type Static } from "@sinclair/typebox";

import { SystemPackageV1Schema } from "./package.js";
import { ImageDescriptorSchema } from "../../../../platform/image-attachment.js";

export const SystemImageManifestSchema = Type.Object({
  fileId: ImageDescriptorSchema.properties.fileId,
  checksum: ImageDescriptorSchema.properties.checksum,
  contentType: ImageDescriptorSchema.properties.contentType,
  dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(5 * 1024 * 1024 / 3) * 4 }),
}, { additionalProperties: false });

const UTC_TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$";

export const SystemExportV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    mediaType: Type.Literal("application/vnd.sweetroll.system+json;version=1"),
    exportedAt: Type.String({ pattern: UTC_TIMESTAMP_PATTERN }),
    provenance: Type.Optional(
      Type.Object(
        {
          sourceUrl: Type.Optional(Type.String()),
          license: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    package: SystemPackageV1Schema,
    images: Type.Optional(Type.Array(SystemImageManifestSchema, { maxItems: 128 })),
  },
  { additionalProperties: false },
);
export type SystemExportV1 = Static<typeof SystemExportV1Schema>;
