import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SystemAuthoring } from "../../systems/authoring.js";
import type { SystemItemImageCommand, UploadSystemItemImage } from "../../systems/item-images.js";
import { ImageDescriptorSchema, type ImageAttachmentError } from "../../platform/image-attachment.js";
import type { SystemsRouteDefinition } from "./systems.js";

const UUID = Type.String({ format: "uuid" });
const Params = Type.Object({ systemId: UUID, templateId: Type.String({ minLength: 1, maxLength: 64 }) });
const Command = { expectedRevision: Type.Integer({ minimum: 1 }), idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }) };
const State = Type.Object({ revision: Type.Integer(), image: Type.Union([Type.Null(), ImageDescriptorSchema]), requestId: Type.String() });
const ErrorDto = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), latestRevision: Type.Optional(Type.Integer()) }), requestId: Type.String() });
const Errors = Object.fromEntries([400, 401, 404, 409, 413, 422, 500, 503].map(code => [String(code), ErrorDto]));
const Path = "/systems/:systemId/templates/:templateId/image";
export const systemImageRoutes: readonly SystemsRouteDefinition[] = [
  { method: "get", path: Path, operationId: "get_system_item_image", schema: { params: Params, response: { "200": State, ...Errors } } },
  { method: "put", path: Path, operationId: "put_system_item_image", schema: { params: Params, body: Type.Object({ ...Command,
    description: Type.String({ minLength: 1, maxLength: 500 }), contentType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]), dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(5 * 1024 * 1024 / 3) * 4 }) }, { additionalProperties: false }), response: { "200": State, ...Errors } } },
  { method: "delete", path: Path, operationId: "delete_system_item_image", schema: { params: Params, body: Type.Object(Command, { additionalProperties: false }), response: { "200": State, ...Errors } } },
  ...(["draft", "version"] as const).flatMap(kind => [false, true].map(thumbnail => ({
    method: "get" as const,
    path: `${kind === "draft" ? Path : "/system-versions/:versionId/templates/:templateId/image"}/:fileId${thumbnail ? "/thumbnail" : ""}`,
    operationId: `get_${kind}_item_image_bytes${thumbnail ? "_thumbnail" : ""}`,
    schema: { params: Type.Object({ ...(kind === "draft" ? { systemId: UUID } : { versionId: UUID }), templateId: Type.String({ minLength: 1, maxLength: 64 }), fileId: UUID }), response: { "200": { schema: Type.String({ format: "binary" }), mediaType: "image/*" }, ...Errors } },
  }))),
];
const Status: Record<ImageAttachmentError["code"], number> = { bad_request: 400, not_found: 404, conflict: 409, idempotency_mismatch: 409, result_unavailable: 409, too_large: 413, unprocessable: 422, temporarily_unavailable: 503, internal: 500 };
export function systemImageHandlers(authoring: SystemAuthoring): Record<string, (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>> {
  return Object.fromEntries(systemImageRoutes.map(route => [route.operationId, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = { actorId: request.auth.state === "authenticated" ? request.auth.actorId : "", requestId: request.id };
    const params = request.params as { systemId: string; versionId: string; templateId: string; fileId: string };
    if (route.operationId.includes("_bytes")) {
      const source = route.operationId.startsWith("get_draft") ? { kind: "draft" as const, systemId: params.systemId } : { kind: "version" as const, versionId: params.versionId };
      const r = await authoring.openItemImageBytes(ctx, { source, templateId: params.templateId, fileId: params.fileId, thumbnail: route.path.endsWith("thumbnail") });
      if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
      return reply.type(r.value.contentType).send(r.value.bytes);
    }
    const location = { systemId: params.systemId, templateId: params.templateId };
    const r = route.method === "put" ? await authoring.setItemImage(ctx, { ...(request.body as UploadSystemItemImage), ...location }) : route.method === "delete" ? await authoring.removeItemImage(ctx, { ...(request.body as SystemItemImageCommand), ...location }) : await authoring.openItemImage(ctx, location);
    if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
    return { ...r.value, requestId: request.id };
  }]));
}
