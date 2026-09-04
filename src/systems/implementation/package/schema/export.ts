import { Type, type Static } from "@sinclair/typebox";

import { SystemPackageV1Schema } from "./package.js";

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
  },
  { additionalProperties: false },
);
export type SystemExportV1 = Static<typeof SystemExportV1Schema>;
