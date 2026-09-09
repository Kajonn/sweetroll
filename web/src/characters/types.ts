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

export type EditIntent =
  | { kind: "setField"; fieldId: string; value: unknown }
  | { kind: "bumpResource"; resourceId: string; direction: "up" | "down" }
  | { kind: "executeAction"; actionId: string; inputs?: Record<string, unknown> };
export type QueueEntry = {
  id: string;
  actorId: string;
  characterId: string;
  sequence: number;
  baseRevision: number;
  packageChecksum: string;
  createdAt: string;
  intent: EditIntent;
  attempt: FrozenRequest | null;
};
/**
 * Atomic conflict-recovery replacement. `selectedIds` retire exactly the
 * explicitly reviewed intentions; `replacements` are newly identified,
 * unsent records for the selected reapply/correction only. Unselected
 * records and their provenance are left unchanged. Selection validity
 * (non-empty while entries remain, no duplicates, every id present) is
 * enforced inside the same guarded transaction as the replacement.
 */
export type ResolveEntriesInput = {
  selectedIds: string[];
  replacements: QueueEntry[];
};
/**
 * Explicit conflict-resolution request. `correctedIntents` carries offline-
 * only replacement intents (field sets/resource bumps, never lifecycle or
 * actions) for a subset of the selected ids; any other selected entry is
 * reapplied with its original intent verbatim.
 */
export type ResolveConflictInput = {
  mode: "discard" | "reapply";
  selectedIds: string[];
  correctedIntents?: Record<string, EditIntent>;
};
/**
 * Explicit unknown-outcome review for a retained online attempt. It never
 * retries the stored request and never mints a replacement mutation: it may
 * retire exactly the identified expired attempt only after current state has
 * been fetched and the caller explicitly accepts the unknown outcome.
 */
export type ReviewExpiredAttemptInput = {
  attemptId: string;
  acknowledgeUnknownOutcome: boolean;
};
/**
 * The latest successful online lifecycle/migration result, preserved for
 * later UI consumption (e.g. offering rollback without manual guessing).
 * The migration identifier comes from the deliberate commit/rollback input;
 * the server commit response carries no separate migration id.
 */
export type LastMigrationResult =
  | { operation: "commit"; previewId: string; revision: number }
  | { operation: "rollback"; migrationId: string; revision: number };
export type SessionPhase =
  | "loading"
  | "ready"
  | "offline"
  | "sending"
  | "conflict"
  | "invalid"
  | "reauthenticate"
  | "uncertain"
  | "storage-error"
  | "purged";

export type OpenCharacterResponse = operations["get_characters_characterId"]["responses"]["200"]["content"]["application/json"];
export type CharacterView = OpenCharacterResponse["character"];

export type CreationOptions = operations["get_characters_creation_options"]["responses"]["200"]["content"]["application/json"];

export type CreationVersionsResponse =
  operations["get_characters_creation_versions"]["responses"]["200"]["content"]["application/json"];

export type CreationVersionEntry = CreationVersionsResponse["data"]["versions"][number];
export type CreationVersions = CreationVersionsResponse;

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