import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Characters } from "../../characters/index.js";
import { ImageDescriptorSchema, type ImageAttachmentError } from "../../platform/image-attachment.js";
import type { CharactersRouteDefinition } from "./characters.js";
const Id = Type.String({ format: "uuid" });
const Params = { characterId: Id, entryId: Id };
const State = Type.Object({ revision: Type.Integer({ minimum: 0 }), image: Type.Union([ImageDescriptorSchema, Type.Null()]), requestId: Type.String() });
const ErrorDto = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), latestRevision: Type.Optional(Type.Integer()) }), requestId: Type.String() });
const Errors = Object.fromEntries([400, 401, 404, 409, 413, 422, 500, 503].map(code => [String(code), ErrorDto]));
const Command = { expectedCharacterRevision: Type.Integer({ minimum: 1 }), expectedImageRevision: Type.Integer({ minimum: 0 }), idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }) };
const Path = "/characters/:characterId/entries/:entryId/image";
export const characterEntryImageRoutes: readonly CharactersRouteDefinition[] = [
  { method: "get", path: Path, operationId: "get_character_entry_image", schema: { params: Type.Object(Params), response: { "200": State, ...Errors } } },
  { method: "put", path: Path, operationId: "put_character_entry_image", schema: { params: Type.Object(Params), body: Type.Object({ ...Command, description: Type.String({ minLength: 1, maxLength: 500 }), contentType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]), dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(5 * 1024 * 1024 / 3) * 4 }) }, { additionalProperties: false }), response: { "200": State, ...Errors } } },
  { method: "delete", path: Path, operationId: "delete_character_entry_image", schema: { params: Type.Object(Params), body: Type.Object(Command, { additionalProperties: false }), response: { "200": State, ...Errors } } },
  ...([ ["/thumbnail", "get_character_entry_image_thumbnail"], ["/:fileId", "get_character_entry_image_bytes"], ["/:fileId/thumbnail", "get_character_entry_image_bytes_thumbnail"] ] as const).map(([suffix, operationId]) => ({ method: "get" as const, path: Path + suffix, operationId, schema: { params: Type.Object({ ...Params, ...(suffix.includes(":fileId") ? { fileId: Id } : {}) }), response: { "200": { schema: Type.String({ format: "binary" }), mediaType: "image/*" }, ...Errors } } })),
];
const Status: Record<ImageAttachmentError["code"], number> = { bad_request: 400, not_found: 404, conflict: 409, idempotency_mismatch: 409, result_unavailable: 409, too_large: 413, unprocessable: 422, temporarily_unavailable: 503, internal: 500 };
export function characterEntryImageHandlers(characters: Characters): Record<string, (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>> {
  return Object.fromEntries(characterEntryImageRoutes.map(route => [route.operationId, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = { actorId: request.auth.state === "authenticated" ? request.auth.actorId : "", requestId: request.id };
    const params = request.params as { characterId: string; entryId: string; fileId?: string };
    if (route.method === "get" && route.operationId !== "get_character_entry_image") {
      const r = await characters.openEntryImageBytes(ctx, { ...params, thumbnail: route.path.endsWith("thumbnail") });
      if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
      return reply.type(r.value.contentType).send(r.value.bytes);
    }
    const r = route.method === "get" ? await characters.openEntryImage(ctx, params) : route.method === "put" ? await characters.setEntryImage(ctx, { ...(request.body as Parameters<Characters["setEntryImage"]>[1]), ...params }) : await characters.removeEntryImage(ctx, { ...(request.body as Parameters<Characters["removeEntryImage"]>[1]), ...params });
    if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
    return { ...r.value, requestId: request.id };
  }]));
}
