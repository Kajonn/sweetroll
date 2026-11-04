import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Campaigns } from "../../campaigns/index.js";
import { ImageDescriptorSchema, type ImageAttachmentError } from "../../platform/image-attachment.js";
import type { CampaignsRouteDefinition } from "./campaigns.js";

const Id = Type.String({ format: "uuid" });
const State = Type.Object({ revision: Type.Integer(), image: Type.Union([ImageDescriptorSchema, Type.Null()]), parentRevision: Type.Optional(Type.Integer()), requestId: Type.String() });
const ErrorDto = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), latestRevision: Type.Optional(Type.Integer()) }), requestId: Type.String() });
const Errors = Object.fromEntries([400, 401, 404, 409, 413, 422, 500, 503].map(code => [String(code), ErrorDto]));
export const campaignItemImageRoutes: readonly CampaignsRouteDefinition[] = (["template", "proposal"] as const).flatMap(kind => {
  const path = `/campaigns/:id/item-${kind === "template" ? "templates/:templateId" : "proposals/:proposalId"}/image`;
  const params = { id: Id, ...(kind === "template" ? { templateId: Id } : { proposalId: Id }) };
  const key = { idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }), ...(kind === "template" ? { expectedTemplateRevision: Type.Integer({ minimum: 1 }) } : { expectedProposalRevision: Type.Integer({ minimum: 1 }), expectedImageRevision: Type.Integer({ minimum: 0 }) }) };
  return [
    { method: "get" as const, path, operationId: `get_campaign_${kind}_image`, schema: { params: Type.Object(params), response: { "200": State, ...Errors } } },
    { method: "put" as const, path, operationId: `put_campaign_${kind}_image`, schema: { params: Type.Object(params), body: Type.Object({ ...key, description: Type.String({ minLength: 1, maxLength: 500 }), contentType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]), dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(5 * 1024 * 1024 / 3) * 4 }) }, { additionalProperties: false }), response: { "200": State, ...Errors } } },
    { method: "delete" as const, path, operationId: `delete_campaign_${kind}_image`, schema: { params: Type.Object(params), body: Type.Object(key, { additionalProperties: false }), response: { "200": State, ...Errors } } },
    ...[false, true].map(thumbnail => ({ method: "get" as const, path: `${path}/:fileId${thumbnail ? "/thumbnail" : ""}`, operationId: `get_campaign_${kind}_image_bytes${thumbnail ? "_thumbnail" : ""}`, schema: { params: Type.Object({ ...params, fileId: Id }), response: { "200": { schema: Type.String({ format: "binary" }), mediaType: "image/*" }, ...Errors } } })),
  ];
});
const Status: Record<ImageAttachmentError["code"], number> = { bad_request: 400, not_found: 404, conflict: 409, idempotency_mismatch: 409, result_unavailable: 409, too_large: 413, unprocessable: 422, temporarily_unavailable: 503, internal: 500 };
export function campaignItemImageHandlers(campaigns: Campaigns): Record<string, (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>> {
  return Object.fromEntries(campaignItemImageRoutes.map(route => [route.operationId, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = { actorId: request.auth.state === "authenticated" ? request.auth.actorId : "", requestId: request.id };
    const params = request.params as { id: string; templateId?: string; proposalId?: string; fileId?: string };
    const kind = params.templateId ? "template" as const : "proposal" as const;
    if (route.operationId.includes("_bytes")) {
      const r = await campaigns.openCampaignItemImageBytes(ctx, { campaignId: params.id, resourceId: (params.templateId ?? params.proposalId)!, kind, fileId: params.fileId!, thumbnail: route.path.endsWith("thumbnail") });
      if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
      return reply.type(r.value.contentType).send(r.value.bytes);
    }
    const r = kind === "template" ? route.method === "get" ? await campaigns.openTemplateImage(ctx, { campaignId: params.id, templateId: params.templateId! })
      : route.method === "put" ? await campaigns.setTemplateImage(ctx, { ...(request.body as Parameters<Campaigns["setTemplateImage"]>[1]), campaignId: params.id, templateId: params.templateId! })
        : await campaigns.removeTemplateImage(ctx, { ...(request.body as Parameters<Campaigns["removeTemplateImage"]>[1]), campaignId: params.id, templateId: params.templateId! })
      : route.method === "get" ? await campaigns.openProposalImage(ctx, { campaignId: params.id, proposalId: params.proposalId! })
        : route.method === "put" ? await campaigns.setProposalImage(ctx, { ...(request.body as Parameters<Campaigns["setProposalImage"]>[1]), campaignId: params.id, proposalId: params.proposalId! })
          : await campaigns.removeProposalImage(ctx, { ...(request.body as Parameters<Campaigns["removeProposalImage"]>[1]), campaignId: params.id, proposalId: params.proposalId! });
    if (!r.ok) return reply.code(Status[r.error.code]).send({ error: r.error, requestId: request.id });
    return { ...r.value, requestId: request.id };
  }]));
}
