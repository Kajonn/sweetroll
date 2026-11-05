import { ApiError, type ApiClient } from "../api/client.js";
import type { operations } from "../api/schema.js";

export type PortraitState =
  operations["get_character_portrait"]["responses"][200]["content"]["application/json"];
export type SetPortraitBody = NonNullable<
  operations["put_character_portrait"]["requestBody"]
>["content"]["application/json"];
export type RemovePortraitBody = NonNullable<
  operations["delete_character_portrait"]["requestBody"]
>["content"]["application/json"];
export type CharacterImagesApi = {
  open(characterId: string): Promise<PortraitState>;
  set(characterId: string, body: SetPortraitBody): Promise<PortraitState>;
  remove(characterId: string, body: RemovePortraitBody): Promise<PortraitState>;
};
function checked(value: PortraitState): PortraitState {
  const image = value?.portrait;
  if (
    !Number.isInteger(value?.revision) ||
    value.revision < 0 ||
    (image !== null &&
      (!image ||
        typeof image.fileId !== "string" ||
        typeof image.description !== "string"))
  ) {
    throw new ApiError({
      code: "malformed_response",
      message:
        "The server returned an unexpected portrait response. Retry the exact request.",
      status: 200,
      requestId: "",
      latestRevision: null,
      diagnostics: [],
    });
  }
  return value;
}
export function createCharacterImagesApi(
  client: ApiClient,
): CharacterImagesApi {
  const path = (id: string) => `/characters/${encodeURIComponent(id)}/portrait`;
  return {
    open: (id) => client.fetch<PortraitState>("GET", path(id)).then(checked),
    set: (id, body) =>
      client.fetch<PortraitState>("PUT", path(id), { body }).then(checked),
    remove: (id, body) =>
      client.fetch<PortraitState>("DELETE", path(id), { body }).then(checked),
  };
}
export const portraitUrl = (
  characterId: string,
  fileId?: string,
  thumbnail = true,
) =>
  `/api/characters/${encodeURIComponent(characterId)}/portrait${fileId ? `/${encodeURIComponent(fileId)}` : ""}${thumbnail ? "/thumbnail" : ""}`;
