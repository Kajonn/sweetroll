import { ApiError, type ApiClient } from "../api/client.js";
import type {
  ActivityResponse,
  CharacterExport,
  CommandResultResponse,
  CreationOptions,
  CreationVersions,
  FrozenRequest,
  MigrationPreviewBody,
  MigrationPreviewResponse,
  OpenCharacterResponse,
} from "./types.js";

export type VersionCatalogQuery = {
  cursor?: string | null;
  limit?: number;
  q?: string | null;
  systemId?: string | null;
};

export type CharactersApi = {
  open(characterId: string): Promise<OpenCharacterResponse>;
  creationOptions(versionId: string): Promise<CreationOptions>;
  listCreationVersions(input?: VersionCatalogQuery): Promise<CreationVersions>;
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