// Design 6.8 (extensions plan E6): browser client for extension authoring.
import type { ApiClient } from "../api/client.js";
import type { operations } from "../api/schema.js";

type Responses<Op extends keyof operations> = operations[Op]["responses"];
type Json<Op extends keyof operations, Code extends 200 | 201 = 200> =
  Code extends keyof Responses<Op>
    ? Responses<Op>[Code] extends { content: { "application/json": infer Body } } ? Body : never
    : never;

export type ExtensionListResponse = Json<"get_systems_extensions">;
export type ExtensionListItem = ExtensionListResponse["extensions"][number];
export type ExtensionWorkspaceResponse = Json<"get_extension">;
export type ExtensionWorkspace = ExtensionWorkspaceResponse["workspace"];
export type ExtensionDocument = NonNullable<ExtensionWorkspace["draft"]>["document"];
export type ExtensionPublishResponse = Json<"post_extensions_publish">;
export type CreationVersionsResponse = Json<"get_characters_creation_versions">;
export type BaseVersionChoice = CreationVersionsResponse["data"]["versions"][number];
export type SystemExportResponse =
  operations["get_system_versions_export"]["responses"][200]["content"]["application/vnd.sweetroll.system+json;version=1"];

export function listExtensions(client: ApiClient, systemId: string): Promise<ExtensionListResponse> {
  return client.fetch<ExtensionListResponse>("GET", `/systems/${encodeURIComponent(systemId)}/extensions`, { query: { limit: 100 } });
}

export function createExtension(
  client: ApiClient,
  systemId: string,
  body: { baseVersionId: string; name: string; idempotencyKey: string },
): Promise<Json<"post_systems_extensions", 201>> {
  return client.fetch("POST", `/systems/${encodeURIComponent(systemId)}/extensions`, { body });
}

export function openExtension(client: ApiClient, extensionId: string): Promise<ExtensionWorkspaceResponse> {
  return client.fetch<ExtensionWorkspaceResponse>("GET", `/extensions/${encodeURIComponent(extensionId)}`);
}

export function saveExtensionDraft(
  client: ApiClient,
  extensionId: string,
  body: { expectedRevision: number; document: ExtensionDocument; baseVersionId?: string },
): Promise<ExtensionWorkspaceResponse> {
  return client.fetch<ExtensionWorkspaceResponse>("PUT", `/extensions/${encodeURIComponent(extensionId)}/draft`, { body });
}

export function publishExtension(
  client: ApiClient,
  extensionId: string,
  body: { expectedRevision: number; semanticVersion: string; releaseNotes: string; acknowledgeBreaking: boolean; idempotencyKey: string },
): Promise<ExtensionPublishResponse> {
  return client.fetch<ExtensionPublishResponse>("POST", `/extensions/${encodeURIComponent(extensionId)}/publish`, { body });
}

/** Published versions of the base system the actor may use, newest first. */
export function listBaseVersions(client: ApiClient, systemId: string): Promise<CreationVersionsResponse> {
  return client.fetch<CreationVersionsResponse>("GET", "/characters/creation-versions", { query: { systemId, limit: 100 } });
}

/** The base version's package: character fields, sheets and slots for formula help. */
export function loadBasePackage(client: ApiClient, versionId: string): Promise<SystemExportResponse> {
  return client.fetch<SystemExportResponse>("GET", `/system-versions/${encodeURIComponent(versionId)}/export`);
}
