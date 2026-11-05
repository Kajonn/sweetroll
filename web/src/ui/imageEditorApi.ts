import { ApiError, type ApiClient } from "../api/client.js";
import type { operations } from "../api/schema.js";

export type ImageState = Omit<operations["get_character_entry_image"]["responses"][200]["content"]["application/json"], "requestId"> & { parentRevision?: number };
export type Artwork = NonNullable<ImageState["image"]>;
export type ImageCommand = { expectedImageRevision: number; expectedParentRevision?: number; idempotencyKey: string };
export type ImageUpload = ImageCommand & { description: string; contentType: "image/png" | "image/jpeg" | "image/webp"; dataBase64: string };
export type ImageEditorApi = {
  read(): Promise<ImageState>;
  upload(body: ImageUpload): Promise<ImageState>;
  remove(body: ImageCommand): Promise<ImageState>;
  imageUrl(fileId: string, thumbnail?: boolean): string;
};
export function checkedImageState(value: ImageState): ImageState {
  const image = value?.image;
  if (!Number.isInteger(value?.revision) || value.revision < 0 || (image !== null && (!image || typeof image.fileId !== "string" || typeof image.description !== "string" || !image.description.trim()))) {
    throw new ApiError({ code: "malformed_response", message: "The server returned an unexpected artwork response. Retry the exact request.", status: 200, requestId: "", latestRevision: null, diagnostics: [] });
  }
  return value;
}
/** Parent-specific routes and revision contracts; no global asset endpoint. */
export function createImageEditorApi(client: ApiClient, path: string, kind: "system" | "template" | "proposal" | "entry"): ImageEditorApi {
  function command(body: ImageCommand | ImageUpload) {
    const { expectedImageRevision, expectedParentRevision, ...rest } = body;
    if (kind === "system") return { ...rest, expectedRevision: expectedImageRevision };
    if (kind === "template") return { ...rest, expectedTemplateRevision: expectedImageRevision };
    return { ...rest, expectedImageRevision, ...(kind === "proposal" ? { expectedProposalRevision: expectedParentRevision } : { expectedCharacterRevision: expectedParentRevision }) };
  }
  return {
    read: () => client.fetch<ImageState>("GET", path).then(checkedImageState),
    upload: body => client.fetch<ImageState>("PUT", path, { body: command(body) }).then(checkedImageState),
    remove: body => client.fetch<ImageState>("DELETE", path, { body: command(body) }).then(checkedImageState),
    imageUrl: (id, thumbnail = true) => `/api${path}/${encodeURIComponent(id)}${thumbnail ? "/thumbnail" : ""}`,
  };
}
