import { ApiError, type ApiClient } from "../api/client.js";
import type {
  ActivityResponse,
  AddCharacterEntryBody,
  AddCharacterEntryResponse,
  BumpCharacterResourceBody,
  BumpCharacterResourceResponse,
  CharacterExport,
  CharacterList,
  CommandResultResponse,
  CreationOptions,
  CreationVersions,
  DuplicateCharacterBody,
  DuplicateCharacterResponse,
  EntryTemplatesResponse,
  ExecuteCharacterActionBody,
  ExecuteCharacterActionResponse,
  FrozenRequest,
  MigrationPreviewBody,
  MigrationPreviewResponse,
  OpenCharacterResponse,
  RemoveCharacterEntryBody,
  RemoveCharacterEntryResponse,
  UpdateCharacterEntryBody,
  UpdateCharacterEntryResponse,
} from "./types.js";

export type VersionCatalogQuery = {
  cursor?: string | null;
  limit?: number;
  q?: string | null;
  systemId?: string | null;
};

export type CharacterListQuery = {
  cursor?: string | null;
  limit?: number;
};

export type CharactersApi = {
  open(characterId: string): Promise<OpenCharacterResponse>;
  creationOptions(versionId: string): Promise<CreationOptions>;
  listCreationVersions(input?: VersionCatalogQuery): Promise<CreationVersions>;
  listCharacters(input?: CharacterListQuery): Promise<CharacterList>;
  duplicateCharacter(characterId: string, body: DuplicateCharacterBody): Promise<DuplicateCharacterResponse>;
  bumpCharacterResource(
    characterId: string,
    resourceId: string,
    body: BumpCharacterResourceBody,
  ): Promise<BumpCharacterResourceResponse>;
  executeCharacterAction(
    characterId: string,
    actionId: string,
    body: ExecuteCharacterActionBody,
  ): Promise<ExecuteCharacterActionResponse>;
  addCharacterEntry(characterId: string, body: AddCharacterEntryBody): Promise<AddCharacterEntryResponse>;
  removeCharacterEntry(
    characterId: string,
    entryId: string,
    body: RemoveCharacterEntryBody,
  ): Promise<RemoveCharacterEntryResponse>;
  updateCharacterEntry(
    characterId: string,
    entryId: string,
    body: UpdateCharacterEntryBody,
  ): Promise<UpdateCharacterEntryResponse>;
  listEntryTemplates(characterId: string): Promise<EntryTemplatesResponse>;
  activity(characterId: string, cursor: string | null): Promise<ActivityResponse>;
  send(request: FrozenRequest): Promise<CommandResultResponse>;
  export(characterId: string): Promise<CharacterExport>;
  previewMigration(characterId: string, body: MigrationPreviewBody): Promise<MigrationPreviewResponse>;
};

export function createCharactersApi(client: ApiClient): CharactersApi {
  const expectJsonObject = async <T>(resolved: unknown): Promise<T> => {
    if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
      // A 2xx that did not produce the expected payload is an uncertain
      // mutation outcome: the request may already have applied server-side.
      // Surface it as an error so callers retain the exact frozen attempt
      // instead of issuing a fresh idempotency key.
      throw new ApiError({
        code: "malformed_response",
        message: "The server returned an unexpected response.",
        status: 200,
        requestId: "",
        latestRevision: null,
        diagnostics: [],
      });
    }
    return resolved as T;
  };

  return {
    open: (characterId) => client.fetch<OpenCharacterResponse>("GET", `/characters/${characterId}`),
    creationOptions: (versionId) =>
      client.fetch<CreationOptions>("GET", "/characters/creation-options", {
        query: { systemVersionId: versionId },
      }),
    listCreationVersions: (input) =>
      input === undefined
        ? client.fetch<CreationVersions>("GET", "/characters/creation-versions")
        : client.fetch<CreationVersions>("GET", "/characters/creation-versions", {
          query: {
            cursor: input.cursor ?? undefined,
            limit: input.limit ?? undefined,
            q: input.q ?? undefined,
            systemId: input.systemId ?? undefined,
          },
        }),
    listCharacters: (input) =>
      input === undefined
        ? client.fetch<CharacterList>("GET", "/characters")
        : client.fetch<CharacterList>("GET", "/characters", {
          query: {
            cursor: input.cursor ?? undefined,
            limit: input.limit ?? undefined,
          },
        }),
    duplicateCharacter: (characterId, body) =>
      client.fetch<DuplicateCharacterResponse>("POST", `/characters/${characterId}/duplicate`, {
        body,
      }),
    // ONLINE-ONLY GM session-board wrappers: they call the same HTTP contracts
    // as the character session queue but bypass the offline durable queue.
    // The player sheet keeps using the session; these must never be used
    // while offline (callers gate on `online`).
    bumpCharacterResource: (characterId, resourceId, body) =>
      client.fetch<BumpCharacterResourceResponse>("POST", `/characters/${characterId}/resources/${resourceId}/bump`, { body }),
    executeCharacterAction: (characterId, actionId, body) =>
      client.fetch<ExecuteCharacterActionResponse>("POST", `/characters/${characterId}/actions/${actionId}`, { body }),
    // ONLINE-ONLY entry wrappers (same contract as the session queue; the
    // player sheet uses the durable session intents below, these never run
    // offline). listEntryTemplates backs the slot add-flow template picker.
    addCharacterEntry: (characterId, body) =>
      client.fetch<AddCharacterEntryResponse>("POST", `/characters/${characterId}/entries`, { body }),
    removeCharacterEntry: (characterId, entryId, body) =>
      client.fetch<RemoveCharacterEntryResponse>("DELETE", `/characters/${characterId}/entries/${entryId}`, { body }),
    updateCharacterEntry: (characterId, entryId, body) =>
      client.fetch<UpdateCharacterEntryResponse>("PATCH", `/characters/${characterId}/entries/${entryId}`, { body }),
    listEntryTemplates: (characterId) =>
      client.fetch<EntryTemplatesResponse>("GET", `/characters/${characterId}/templates`),
    activity: (characterId, cursor) =>
      client.fetch<ActivityResponse>("GET", `/characters/${characterId}/activity`, {
        query: { cursor },
      }),
    send: async (request) =>
      expectJsonObject<CommandResultResponse>(
        await client.fetch(request.method, request.path, { body: request.body }),
      ),
    export: (characterId) =>
      client.fetch<CharacterExport>("POST", `/characters/${characterId}/exports`),
    previewMigration: (characterId, body) =>
      client.fetch<MigrationPreviewResponse>("POST", `/characters/${characterId}/migration-previews`, {
        body,
      }),
  };
}