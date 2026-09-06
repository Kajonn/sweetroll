import type { operations } from "../api/schema.js";

/**
 * A fully-frozen outgoing request. Send forwards method, path and body to the
 * server verbatim; the body already carries its idempotencyKey, so the
 * transport never mints or rewrites one.
 */
export type FrozenRequest = {
  method: "POST" | "PATCH";
  path: string;
  body: Record<string, unknown> & { idempotencyKey: string };
  firstAttemptAt: string;
};

export type OpenCharacterResponse = operations["get_characters_characterId"]["responses"]["200"]["content"]["application/json"];
export type CharacterView = OpenCharacterResponse["character"];

export type CreationOptions = operations["get_characters_creation_options"]["responses"]["200"]["content"]["application/json"];

export type ActivityResponse = operations["get_characters_characterId_activity"]["responses"]["200"]["content"]["application/json"];
export type ActivityEvent = ActivityResponse["events"][number];

export type CommandResultResponse = operations["post_characters_characterId_fields_fieldId_set"]["responses"]["200"]["content"]["application/json"];
export type CommandResult = CommandResultResponse["result"];

export type CharacterExport = operations["post_characters_characterId_exports"]["responses"]["200"]["content"]["application/vnd.sweetroll.character+json;version=1"];

export type MigrationPreviewResponse = operations["post_characters_characterId_migration_previews"]["responses"]["201"]["content"]["application/json"];
export type MigrationPreview = MigrationPreviewResponse["preview"];
export type MigrationPreviewBody = NonNullable<
  operations["post_characters_characterId_migration_previews"]["requestBody"]
>["content"]["application/json"];