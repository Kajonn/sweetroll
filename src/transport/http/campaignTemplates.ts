import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Campaigns } from "../../campaigns/index.js";
import type {
  CreateTemplate,
  TemplateMutation,
  TemplateContent,
  ListTemplates,
} from "../../campaigns/templates.js";
import type { CampaignsRouteDefinition } from "./campaigns.js";

const Kind = Type.Union([
  Type.Literal("item"),
  Type.Literal("spell"),
  Type.Literal("talent"),
  Type.Literal("effect"),
]);
const Content = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
    defaultQuantity: Type.Optional(
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
);
export const CampaignTemplateDto = Type.Object({
  templateId: Type.String(),
  campaignId: Type.String(),
  creatorId: Type.String(),
  kind: Kind,
  audience: Type.Literal("all_players"),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  revision: Type.Integer(),
  contentRevision: Type.Integer(),
  content: Content,
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const ErrorDto = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
  requestId: Type.String(),
});
const Errors = {
  "400": ErrorDto,
  "401": ErrorDto,
  "403": ErrorDto,
  "404": ErrorDto,
  "409": ErrorDto,
  "413": ErrorDto,
  "500": ErrorDto,
};
const Result = Type.Object({
  template: CampaignTemplateDto,
  requestId: Type.String(),
});
const CampaignParams = Type.Object({ id: Type.String({ format: "uuid" }) });
const Params = Type.Object({
  id: Type.String({ format: "uuid" }),
  templateId: Type.String({ format: "uuid" }),
});
const Mutation = {
  expectedTemplateRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
};
export const campaignTemplateRoutes: readonly CampaignsRouteDefinition[] = [
  {
    method: "post",
    path: "/campaigns/:id/item-templates",
    operationId: "post_campaigns_id_item_templates",
    schema: {
      params: CampaignParams,
      body: Type.Object(
        {
          ...Mutation,
          expectedTemplateRevision: Type.Literal(0),
          kind: Kind,
          content: Content,
        },
        { additionalProperties: false },
      ),
      response: { "201": Result, ...Errors },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/item-templates",
    operationId: "get_campaigns_id_item_templates",
    schema: {
      params: CampaignParams,
      querystring: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String()),
        kind: Type.Optional(Kind),
        status: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("archived")]),
        ),
      }),
      response: {
        "200": Type.Object({
          templates: Type.Array(CampaignTemplateDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        ...Errors,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/item-templates/:templateId",
    operationId: "get_campaigns_id_item_templates_templateId",
    schema: { params: Params, response: { "200": Result, ...Errors } },
  },
  {
    method: "patch",
    path: "/campaigns/:id/item-templates/:templateId",
    operationId: "patch_campaigns_id_item_templates_templateId",
    schema: {
      params: Params,
      body: Type.Object(
        { ...Mutation, content: Content },
        { additionalProperties: false },
      ),
      response: { "200": Result, ...Errors },
    },
  },
  ...(["archive", "recover"] as const).map((operation) => ({
    method: "post" as const,
    path: `/campaigns/:id/item-templates/:templateId/${operation}`,
    operationId: `post_campaigns_id_item_templates_templateId_${operation}`,
    schema: {
      params: Params,
      body: Type.Object(Mutation, { additionalProperties: false }),
      response: { "200": Result, ...Errors },
    },
  })),
];
export function campaignTemplateHandlers(
  campaigns: Campaigns,
): Record<
  string,
  (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
> {
  const handlers: Record<
    string,
    (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  > = {};
  for (const route of campaignTemplateRoutes)
    handlers[route.operationId] = async (request, reply) => {
      const params = request.params as { id: string; templateId?: string };
      const ctx = {
        actorId:
          request.auth.state === "authenticated" ? request.auth.actorId : "",
        requestId: request.id,
      };
      const location = {
        campaignId: params.id,
        templateId: params.templateId!,
      };
      const body = request.body as TemplateMutation & {
        content: TemplateContent;
      };
      const result =
        route.operationId === "post_campaigns_id_item_templates"
          ? await campaigns.createTemplate(ctx, {
              ...(request.body as CreateTemplate),
              campaignId: params.id,
            })
          : route.operationId === "get_campaigns_id_item_templates"
            ? await campaigns.listTemplates(ctx, {
                ...(request.query as ListTemplates),
                campaignId: params.id,
              })
            : route.method === "get"
              ? await campaigns.openTemplate(ctx, location)
              : route.method === "patch"
                ? await campaigns.updateTemplate(ctx, { ...body, ...location })
                : route.operationId.endsWith("archive")
                  ? await campaigns.archiveTemplate(ctx, {
                      ...body,
                      ...location,
                    })
                  : await campaigns.recoverTemplate(ctx, {
                      ...body,
                      ...location,
                    });
      reply.header("cache-control", "no-store");
      if (!result.ok)
        return reply
          .code(
            (
              {
                not_found: 404,
                forbidden: 403,
                conflict: 409,
                idempotency_mismatch: 409,
                result_unavailable: 409,
                too_large: 413,
                bad_request: 400,
              } as Record<string, number>
            )[result.error.code] ?? 500,
          )
          .send({ error: result.error, requestId: request.id });
      if (route.operationId === "get_campaigns_id_item_templates")
        return { ...result.value, requestId: request.id };
      return reply
        .code(
          route.operationId === "post_campaigns_id_item_templates" ? 201 : 200,
        )
        .send({ template: result.value, requestId: request.id });
    };
  return handlers;
}
