import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Campaigns } from "../../campaigns/index.js";
import type {
  SubmitProposal,
  DecideProposal,
  ListProposals,
} from "../../campaigns/proposals.js";
import type { CampaignsRouteDefinition } from "./campaigns.js";
import { CampaignTemplateDto } from "./campaignTemplates.js";
const Kind = Type.Union([
  Type.Literal("item"),
  Type.Literal("spell"),
  Type.Literal("talent"),
  Type.Literal("effect"),
]);
const Status = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
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
export const CampaignProposalDto = Type.Object({
  proposalId: Type.String(),
  campaignId: Type.String(),
  submitterId: Type.String(),
  kind: Kind,
  content: Content,
  status: Status,
  revision: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  decision: Type.Union([
    Type.Null(),
    Type.Object({
      actorId: Type.String(),
      decidedAt: Type.String(),
      reason: Type.Union([Type.String(), Type.Null()]),
    }),
  ]),
  approvedTemplateId: Type.Union([Type.String(), Type.Null()]),
  eligibility: Type.Optional(
    Type.Object({
      canApprove: Type.Boolean(),
      reason: Type.Union([
        Type.Null(),
        ...(
          [
            "already_decided",
            "campaign_archived",
            "submitter_inactive",
            "catalog_full",
          ] as const
        ).map((x) => Type.Literal(x)),
      ]),
    }),
  ),
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
const Campaign = Type.Object({ id: Type.String({ format: "uuid" }) });
const Params = Type.Object({
  ...Campaign.properties,
  proposalId: Type.String({ format: "uuid" }),
});
const Key = {
  expectedProposalRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
};
const Result = Type.Object({
  proposal: CampaignProposalDto,
  requestId: Type.String(),
});
export const campaignProposalRoutes: readonly CampaignsRouteDefinition[] = [
  {
    method: "post",
    path: "/campaigns/:id/item-proposals",
    operationId: "post_campaigns_id_item_proposals",
    schema: {
      params: Campaign,
      body: Type.Object(
        {
          ...Key,
          expectedProposalRevision: Type.Literal(0),
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
    path: "/campaigns/:id/item-proposals",
    operationId: "get_campaigns_id_item_proposals",
    schema: {
      params: Campaign,
      querystring: Type.Object(
        {
          status: Type.Optional(Status),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Type.String({ maxLength: 2000 })),
        },
        { additionalProperties: false },
      ),
      response: {
        "200": Type.Object({
          proposals: Type.Array(CampaignProposalDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        ...Errors,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/item-proposals/:proposalId",
    operationId: "get_campaigns_id_item_proposals_proposalId",
    schema: { params: Params, response: { "200": Result, ...Errors } },
  },
  ...(["approve", "reject"] as const).map((operation) => ({
    method: "post" as const,
    path: `/campaigns/:id/item-proposals/:proposalId/${operation}`,
    operationId: `post_campaigns_id_item_proposals_proposalId_${operation}`,
    schema: {
      params: Params,
      body: Type.Object(
        {
          ...Key,
          ...(operation === "reject"
            ? { reason: Type.Optional(Type.String({ maxLength: 2000 })) }
            : {}),
        },
        { additionalProperties: false },
      ),
      response: {
        "200":
          operation === "approve"
            ? Type.Object({
                ...Result.properties,
                template: CampaignTemplateDto,
              })
            : Result,
        ...Errors,
      },
    },
  })),
];
export function campaignProposalHandlers(
  campaigns: Campaigns,
): Record<
  string,
  (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
> {
  return Object.fromEntries(
    campaignProposalRoutes.map((route) => [
      route.operationId,
      async (request: FastifyRequest, reply: FastifyReply) => {
        const p = request.params as { id: string; proposalId?: string };
        const ctx = {
          actorId:
            request.auth.state === "authenticated" ? request.auth.actorId : "",
          requestId: request.id,
        };
        const location = { campaignId: p.id, proposalId: p.proposalId! };
        const result =
          route.operationId === "post_campaigns_id_item_proposals"
            ? await campaigns.submitProposal(ctx, {
                ...(request.body as SubmitProposal),
                campaignId: p.id,
              })
            : route.operationId === "get_campaigns_id_item_proposals"
              ? await campaigns.listProposals(ctx, {
                  ...(request.query as ListProposals),
                  campaignId: p.id,
                })
              : route.method === "get"
                ? await campaigns.openProposal(ctx, location)
                : route.operationId.endsWith("approve")
                  ? await campaigns.approveProposal(ctx, {
                      ...(request.body as DecideProposal),
                      ...location,
                    })
                  : await campaigns.rejectProposal(ctx, {
                      ...(request.body as DecideProposal),
                      ...location,
                    });
        reply.header("cache-control", "no-store");
        if (!result.ok)
          return reply
            .code(
              (
                {
                  bad_request: 400,
                  not_found: 404,
                  forbidden: 403,
                  conflict: 409,
                  idempotency_mismatch: 409,
                  result_unavailable: 409,
                  too_large: 413,
                } as Record<string, number>
              )[result.error.code] ?? 500,
            )
            .send({ error: result.error, requestId: request.id });
        const value =
          route.operationId === "get_campaigns_id_item_proposals_proposalId"
            ? { proposal: result.value }
            : result.value;
        return reply
          .code(
            route.operationId === "post_campaigns_id_item_proposals"
              ? 201
              : 200,
          )
          .send({ ...value, requestId: request.id });
      },
    ]),
  );
}
