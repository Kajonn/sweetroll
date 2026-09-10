import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import type {
  CampaignError,
  Campaigns,
  CampaignView,
  ContentView,
  InvitationAcceptSuccess,
  InvitationDeclineSuccess,
  InvitationListItem,
  InvitationMetadata,
  InvitationReview,
  MemberView,
} from "../../campaigns/index.js";
import type { Characters } from "../../characters/index.js";
import {
  prepareCampaignCharacter,
  type CampaignPlacement,
  type PlacedCharacterView,
  type PlacementError,
} from "../../characters/campaignPlacement.js";
import type { SystemRuntime } from "../../systems/runtime.js";
import { CharacterViewDto, toCharacterViewDto } from "./characters.js";

export type BuildCampaignsRoutesInput = {
  campaigns: Campaigns;
  /** Full-sheet composer for placement responses (read outside the placement transaction). */
  characters: Characters;
  /**
   * I6 Task 9: the single shared placement implementation. Bootstrap and the
   * test harness inject the same instance into `createCampaignsModule`
   * (departure return) and here (placement HTTP); never two independent
   * authorization copies.
   */
  placement: CampaignPlacement;
  /** Runtime for campaign-character preparation (outside any transaction). */
  runtime: SystemRuntime;
  /** Transaction owner for placement operations (caller-owned client). */
  pool: Pool;
};

type WireError = { code: string; message: string; latestRevision?: number | null };

const STATUS_BY_CODE: Record<CampaignError["code"] | PlacementError["code"], number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  // I6 Task 5/7 convention: committed-but-undisclosable results are a
  // non-sensitive conflict, never a retry of the same key.
  result_unavailable: 409,
  export_too_large: 413,
  rate_limited: 429,
  internal: 500,
};

const badRequest = (message: string): CampaignError => ({ code: "bad_request", message });
const notFound = (): CampaignError => ({ code: "not_found", message: "The requested campaign does not exist." });
const internal = (): CampaignError => ({ code: "internal", message: "An internal error occurred." });

// ---------------------------------------------------------------------------
// OpenAPI / TypeBox schemas
// ---------------------------------------------------------------------------

const UUID_FORMAT = "uuid";
const DATE_TIME_FORMAT = "date-time";

const CampaignViewDto = Type.Object({
  campaignId: Type.String({ format: UUID_FORMAT }),
  ownerId: Type.String({ format: UUID_FORMAT }),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  title: Type.String(),
  description: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  revision: Type.Integer(),
  accessRevision: Type.Integer(),
  archivedAt: Type.Union([Type.String({ format: DATE_TIME_FORMAT }), Type.Null()]),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const CampaignSummaryDto = Type.Object({
  campaignId: Type.String({ format: UUID_FORMAT }),
  title: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  revision: Type.Integer(),
  accessRevision: Type.Integer(),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const MemberViewDto = Type.Object({
  campaignId: Type.String({ format: UUID_FORMAT }),
  userId: Type.String({ format: UUID_FORMAT }),
  role: Type.Union([Type.Literal("owner"), Type.Literal("co_gm"), Type.Literal("player")]),
  status: Type.Union([Type.Literal("active"), Type.Literal("removed")]),
  generation: Type.Integer(),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const InvitationMetadataDto = Type.Object({
  invitationId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  intendedRole: Type.Union([Type.Literal("player"), Type.Literal("co_gm")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("declined"),
    Type.Literal("revoked"),
  ]),
  expiresAt: Type.String({ format: DATE_TIME_FORMAT }),
  invitationRevision: Type.Integer(),
  issuedBy: Type.String({ format: UUID_FORMAT }),
});

// Task 6 checkpoint, documented in generated contracts: the plaintext token
// exists only in memory and the initial successful response. Same-key replays
// return non-secret metadata with `tokenUnavailable: true` and no `token`
// property — the documented exception to byte-identical response replay.
const InvitationTokenProperty = Type.String({
  description:
    "One-time plaintext invitation token. Present only on the initial issue/rotate success; " +
    "same-key replays return metadata with tokenUnavailable instead. Never logged or persisted.",
});
const InvitationTokenUnavailableProperty = Type.Literal(true, {
  description:
    "Same-key replay marker: no new token is minted and the initial token cannot be recovered. " +
    "Rotate with a new idempotency key after a lost response.",
});
const InvitationIssueDto = Type.Union([
  Type.Object({
    invitationId: InvitationMetadataDto.properties.invitationId,
    campaignId: InvitationMetadataDto.properties.campaignId,
    intendedRole: InvitationMetadataDto.properties.intendedRole,
    status: InvitationMetadataDto.properties.status,
    expiresAt: InvitationMetadataDto.properties.expiresAt,
    invitationRevision: InvitationMetadataDto.properties.invitationRevision,
    issuedBy: InvitationMetadataDto.properties.issuedBy,
    token: InvitationTokenProperty,
  }),
  Type.Object({
    invitationId: InvitationMetadataDto.properties.invitationId,
    campaignId: InvitationMetadataDto.properties.campaignId,
    intendedRole: InvitationMetadataDto.properties.intendedRole,
    status: InvitationMetadataDto.properties.status,
    expiresAt: InvitationMetadataDto.properties.expiresAt,
    invitationRevision: InvitationMetadataDto.properties.invitationRevision,
    issuedBy: InvitationMetadataDto.properties.issuedBy,
    tokenUnavailable: InvitationTokenUnavailableProperty,
  }),
]);

const InvitationReviewDto = Type.Object({
  invitationId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  campaignTitle: Type.String(),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  inviterDisplayName: Type.String(),
  intendedRole: Type.Union([Type.Literal("player"), Type.Literal("co_gm")]),
  expiresAt: Type.String({ format: DATE_TIME_FORMAT }),
  invitationRevision: Type.Integer(),
  accessRevision: Type.Integer(),
});

const InvitationAcceptDto = Type.Object({
  invitationId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  membership: MemberViewDto,
  membershipGeneration: Type.Integer(),
});

const InvitationDeclineDto = Type.Object({
  invitationId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  status: Type.Literal("declined"),
});

const InvitationListItemDto = Type.Object({
  invitationId: Type.String({ format: UUID_FORMAT }),
  intendedRole: Type.Union([Type.Literal("player"), Type.Literal("co_gm")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("declined"),
    Type.Literal("revoked"),
  ]),
  expiresAt: Type.String({ format: DATE_TIME_FORMAT }),
  invitationRevision: Type.Integer(),
  issuedBy: Type.String({ format: UUID_FORMAT }),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const ContentAudienceDto = Type.Union([
  Type.Literal("gm_only"),
  Type.Literal("all_players"),
  Type.Literal("selected_players"),
  Type.Literal("owner_only"),
]);

const ContentSummaryDto = Type.Object({
  contentId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  creatorId: Type.String({ format: UUID_FORMAT }),
  audience: ContentAudienceDto,
  title: Type.String(),
  tags: Type.Array(Type.String()),
  revision: Type.Integer(),
  accessRevision: Type.Integer(),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const ContentViewDto = Type.Object({
  contentId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  creatorId: Type.String({ format: UUID_FORMAT }),
  audience: ContentAudienceDto,
  title: Type.String(),
  tags: Type.Array(Type.String()),
  revision: Type.Integer(),
  accessRevision: Type.Integer(),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
  body: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
  deletedAt: Type.Union([Type.String({ format: DATE_TIME_FORMAT }), Type.Null()]),
  grantedUserIds: Type.Optional(Type.Array(Type.String({ format: UUID_FORMAT }))),
});

const ActivityEventDto = Type.Object({
  eventId: Type.String({ format: UUID_FORMAT }),
  kind: Type.Union([
    Type.Literal("content_created"),
    Type.Literal("content_updated"),
    Type.Literal("content_deleted"),
    Type.Literal("content_recovered"),
    Type.Literal("content_grants_replaced"),
    Type.Literal("roll_executed"),
  ]),
  actorId: Type.String({ format: UUID_FORMAT }),
  sourceContentId: Type.Union([Type.String({ format: UUID_FORMAT }), Type.Null()]),
  sourceRollId: Type.Union([Type.String(), Type.Null()]),
  requestId: Type.String(),
  occurredAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const CampaignExportDto = Type.Object({
  exportVersion: Type.Literal(1),
  campaign: Type.Object({
    campaignId: Type.String({ format: UUID_FORMAT }),
    ownerId: Type.String({ format: UUID_FORMAT }),
    systemVersionId: Type.String({ format: UUID_FORMAT }),
    title: Type.String(),
    description: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    revision: Type.Integer(),
    accessRevision: Type.Integer(),
    createdAt: Type.String({ format: DATE_TIME_FORMAT }),
    updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
  }),
  members: Type.Array(
    Type.Object({
      userId: Type.String({ format: UUID_FORMAT }),
      role: Type.String(),
      status: Type.String(),
      generation: Type.Integer(),
    }),
  ),
  content: Type.Array(
    Type.Object({
      contentId: Type.String({ format: UUID_FORMAT }),
      creatorId: Type.String({ format: UUID_FORMAT }),
      audience: ContentAudienceDto,
      title: Type.String(),
      body: Type.String(),
      tags: Type.Array(Type.String()),
      revision: Type.Integer(),
      accessRevision: Type.Integer(),
      createdAt: Type.String({ format: DATE_TIME_FORMAT }),
      updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
      grantedUserIds: Type.Optional(Type.Array(Type.String({ format: UUID_FORMAT }))),
    }),
  ),
  activity: Type.Array(ActivityEventDto),
  rolls: Type.Array(
    Type.Object({
      rollId: Type.String(),
      characterId: Type.String({ format: UUID_FORMAT }),
      actorId: Type.String({ format: UUID_FORMAT }),
      actionId: Type.String(),
      audience: Type.Union([Type.Literal("owner_only"), Type.Literal("gm_only"), Type.Literal("campaign")]),
      expression: Type.String(),
      dice: Type.Unknown(),
      bindings: Type.Unknown(),
      total: Type.Number(),
      output: Type.String(),
      occurredAt: Type.String({ format: DATE_TIME_FORMAT }),
    }),
  ),
});

const CampaignCharacterSummaryDto = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  campaignId: Type.String({ format: UUID_FORMAT }),
  name: Type.String(),
  entityDefinitionId: Type.String(),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  revision: Type.Integer(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  placementGeneration: Type.Integer(),
  controllers: Type.Array(Type.String({ format: UUID_FORMAT })),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const CampaignErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  }),
  requestId: Type.String(),
});

const UnauthorizedEnvelope = Type.Object({
  error: Type.Object({
    code: Type.Literal("unauthorized"),
    message: Type.String(),
  }),
  requestId: Type.String(),
});

const ErrorResponses = {
  "400": CampaignErrorEnvelope,
  "401": UnauthorizedEnvelope,
  "404": CampaignErrorEnvelope,
  "409": CampaignErrorEnvelope,
  "413": CampaignErrorEnvelope,
  "429": CampaignErrorEnvelope,
  "500": CampaignErrorEnvelope,
};

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const CreateCampaignBody = Type.Object({
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const UpdateCampaignBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const CampaignLifecycleBody = Type.Object({
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const PageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String()),
});

const ChangeRoleBody = Type.Object({
  role: Type.Union([Type.Literal("co_gm"), Type.Literal("player")]),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

// DELETE mutations carry explicit revision/key input in the JSON body, the
// established transport convention for revision-guarded mutations.
const RemoveMemberBody = Type.Object({
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const IssueInvitationBody = Type.Object({
  intendedRole: Type.Union([Type.Literal("player"), Type.Literal("co_gm")]),
  expiresAt: Type.Optional(Type.String({ format: DATE_TIME_FORMAT })),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const RotateInvitationBody = Type.Object({
  expectedInvitationRevision: Type.Integer({ minimum: 1 }),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  expiresAt: Type.Optional(Type.String({ format: DATE_TIME_FORMAT })),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const RevokeInvitationBody = Type.Object({
  expectedInvitationRevision: Type.Integer({ minimum: 1 }),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

// Invitation tokens travel in POST bodies only, never in URL parameters.
const ReviewInvitationBody = Type.Object({
  token: Type.String({
    minLength: 1,
    description: "Single-use bearer token, delivered out of band. Never appears in URLs or logs.",
  }),
});

const ConsumeInvitationBody = Type.Object({
  campaignId: Type.String({
    format: UUID_FORMAT,
    description: "Campaign reviewed by the token holder; no campaign revision is required from a nonmember.",
  }),
  token: Type.String({ minLength: 1 }),
  expectedInvitationRevision: Type.Integer({ minimum: 1 }),
  reviewedAccessRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const CreateCampaignCharacterBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  entityDefinitionId: Type.String({ minLength: 1 }),
  initialValues: Type.Optional(Type.Object({}, { additionalProperties: true })),
  controllerUserIds: Type.Optional(Type.Array(Type.String({ format: UUID_FORMAT }))),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const AssignControllersBody = Type.Object({
  controllerUserIds: Type.Array(Type.String({ format: UUID_FORMAT })),
  designateClaimants: Type.Optional(Type.Array(Type.String({ format: UUID_FORMAT }))),
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  expectedCharacterRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ClaimCharacterBody = Type.Object({
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  expectedCharacterRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const AdoptCharacterBody = Type.Object({
  expectedCampaignRevision: Type.Integer({ minimum: 1 }),
  expectedCharacterRevision: Type.Integer({ minimum: 1 }),
  acknowledgedDisclosure: Type.Boolean({
    description:
      "Explicit acknowledgement that all sheet contents return to the original owner on departure, including GM edits.",
  }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const CreateContentBody = Type.Object({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  audience: Type.Optional(ContentAudienceDto),
  grantedUserIds: Type.Optional(Type.Array(Type.String({ format: UUID_FORMAT }))),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const UpdateContentBody = Type.Object({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  audience: Type.Optional(ContentAudienceDto),
  expectedContentRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ContentMutationBody = Type.Object({
  expectedContentRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ReplaceGrantsBody = Type.Object({
  grantedUserIds: Type.Array(Type.String({ format: UUID_FORMAT })),
  expectedContentRevision: Type.Integer({ minimum: 1 }),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ExportCampaignBody = Type.Object({
  idempotencyKey: Type.String({ minLength: 1 }),
});

const CampaignIdParams = Type.Object({ id: Type.String({ format: UUID_FORMAT }) });
const MemberParams = Type.Object({
  id: Type.String({ format: UUID_FORMAT }),
  userId: Type.String({ format: UUID_FORMAT }),
});
const InvitationParams = Type.Object({
  id: Type.String({ format: UUID_FORMAT }),
  inviteId: Type.String({ format: UUID_FORMAT }),
});
const ContentIdParams = Type.Object({ id: Type.String({ format: UUID_FORMAT }) });
const CampaignCharacterParams = Type.Object({
  id: Type.String({ format: UUID_FORMAT }),
  characterId: Type.String({ format: UUID_FORMAT }),
});

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type RouteResponse = TSchema | { schema: TSchema; mediaType?: string };
type RouteSchema = {
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<string, RouteResponse>;
};
export type CampaignsRouteDefinition = {
  method: HttpMethod;
  path: string;
  operationId: string;
  schema: RouteSchema;
};

export const campaignsRouteDefinitions: readonly CampaignsRouteDefinition[] = [
  {
    method: "post",
    path: "/campaigns",
    operationId: "post_campaigns",
    schema: {
      body: CreateCampaignBody,
      response: {
        "201": Type.Object({ campaign: CampaignViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns",
    operationId: "get_campaigns",
    schema: {
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          campaigns: Type.Array(CampaignSummaryDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id",
    operationId: "get_campaigns_id",
    schema: {
      params: CampaignIdParams,
      response: {
        "200": Type.Object({ campaign: CampaignViewDto, requestId: Type.String() }),
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "patch",
    path: "/campaigns/:id",
    operationId: "patch_campaigns_id",
    schema: {
      params: CampaignIdParams,
      body: UpdateCampaignBody,
      response: {
        "200": Type.Object({ campaign: CampaignViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/archive",
    operationId: "post_campaigns_id_archive",
    schema: {
      params: CampaignIdParams,
      body: CampaignLifecycleBody,
      response: {
        "200": Type.Object({ campaign: CampaignViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/recover",
    operationId: "post_campaigns_id_recover",
    schema: {
      params: CampaignIdParams,
      body: CampaignLifecycleBody,
      response: {
        "200": Type.Object({ campaign: CampaignViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/members",
    operationId: "get_campaigns_id_members",
    schema: {
      params: CampaignIdParams,
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          members: Type.Array(MemberViewDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "patch",
    path: "/campaigns/:id/members/:userId",
    operationId: "patch_campaigns_id_members_userId",
    schema: {
      params: MemberParams,
      body: ChangeRoleBody,
      response: {
        "200": Type.Object({ member: MemberViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "delete",
    path: "/campaigns/:id/members/:userId",
    operationId: "delete_campaigns_id_members_userId",
    schema: {
      params: MemberParams,
      body: RemoveMemberBody,
      response: {
        "200": Type.Object({ member: MemberViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/invitations",
    operationId: "post_campaigns_id_invitations",
    schema: {
      params: CampaignIdParams,
      body: IssueInvitationBody,
      response: {
        "201": Type.Object({ invitation: InvitationIssueDto, requestId: Type.String() }),
        ...ErrorResponses,
        "429": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/invitations",
    operationId: "get_campaigns_id_invitations",
    schema: {
      params: CampaignIdParams,
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          invitations: Type.Array(InvitationListItemDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/invitations/:inviteId/rotate",
    operationId: "post_campaigns_id_invitations_inviteId_rotate",
    schema: {
      params: InvitationParams,
      body: RotateInvitationBody,
      response: {
        "200": Type.Object({ invitation: InvitationIssueDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/invitations/:inviteId/revoke",
    operationId: "post_campaigns_id_invitations_inviteId_revoke",
    schema: {
      params: InvitationParams,
      body: RevokeInvitationBody,
      response: {
        "200": Type.Object({ invitation: InvitationMetadataDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/invitations/review",
    operationId: "post_invitations_review",
    schema: {
      body: ReviewInvitationBody,
      response: {
        "200": Type.Object({ review: InvitationReviewDto, requestId: Type.String() }),
        ...ErrorResponses,
        "429": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/invitations/accept",
    operationId: "post_invitations_accept",
    schema: {
      body: ConsumeInvitationBody,
      response: {
        "200": Type.Object({ acceptance: InvitationAcceptDto, requestId: Type.String() }),
        ...ErrorResponses,
        "429": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/invitations/decline",
    operationId: "post_invitations_decline",
    schema: {
      body: ConsumeInvitationBody,
      response: {
        "200": Type.Object({ declination: InvitationDeclineDto, requestId: Type.String() }),
        ...ErrorResponses,
        "429": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/characters",
    operationId: "get_campaigns_id_characters",
    schema: {
      params: CampaignIdParams,
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          characters: Type.Array(CampaignCharacterSummaryDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/characters",
    operationId: "post_campaigns_id_characters",
    schema: {
      params: CampaignIdParams,
      body: CreateCampaignCharacterBody,
      response: {
        "201": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/characters/:characterId/assign",
    operationId: "post_campaigns_id_characters_characterId_assign",
    schema: {
      params: CampaignCharacterParams,
      body: AssignControllersBody,
      response: {
        "200": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/characters/:characterId/claim",
    operationId: "post_campaigns_id_characters_characterId_claim",
    schema: {
      params: CampaignCharacterParams,
      body: ClaimCharacterBody,
      response: {
        "200": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/characters/:characterId/adopt",
    operationId: "post_campaigns_id_characters_characterId_adopt",
    schema: {
      params: CampaignCharacterParams,
      body: AdoptCharacterBody,
      response: {
        "200": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/content",
    operationId: "get_campaigns_id_content",
    schema: {
      params: CampaignIdParams,
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          content: Type.Array(ContentSummaryDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/content",
    operationId: "post_campaigns_id_content",
    schema: {
      params: CampaignIdParams,
      body: CreateContentBody,
      response: {
        "201": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/content/:id",
    operationId: "get_content_id",
    schema: {
      params: ContentIdParams,
      response: {
        "200": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "patch",
    path: "/content/:id",
    operationId: "patch_content_id",
    schema: {
      params: ContentIdParams,
      body: UpdateContentBody,
      response: {
        "200": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "delete",
    path: "/content/:id",
    operationId: "delete_content_id",
    schema: {
      params: ContentIdParams,
      body: ContentMutationBody,
      response: {
        "200": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/content/:id/grants",
    operationId: "post_content_id_grants",
    schema: {
      params: ContentIdParams,
      body: ReplaceGrantsBody,
      response: {
        "200": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/content/:id/recover",
    operationId: "post_content_id_recover",
    schema: {
      params: ContentIdParams,
      body: ContentMutationBody,
      response: {
        "200": Type.Object({ content: ContentViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/campaigns/:id/activity",
    operationId: "get_campaigns_id_activity",
    schema: {
      params: CampaignIdParams,
      querystring: PageQuery,
      response: {
        "200": Type.Object({
          events: Type.Array(ActivityEventDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CampaignErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CampaignErrorEnvelope,
        "500": CampaignErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/campaigns/:id/exports",
    operationId: "post_campaigns_id_exports",
    schema: {
      params: CampaignIdParams,
      body: ExportCampaignBody,
      response: {
        "200": Type.Object({ export: CampaignExportDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function toFastifyResponses(response: Record<string, RouteResponse> | undefined): Record<string, TSchema> | undefined {
  if (response === undefined) return undefined;
  const out: Record<string, TSchema> = {};
  for (const [status, value] of Object.entries(response)) {
    out[status] = "schema" in value ? value.schema : value;
  }
  return out;
}

export const buildCampaignsRoutes: (input: BuildCampaignsRoutesInput) => FastifyPluginCallback =
  ({ campaigns, characters, placement, runtime, pool }) =>
  async (app) => {
    app.addHook("onSend", async (request, reply) => {
      reply.header("x-request-id", request.id);
      // Spec 4.3: every protected campaign response is non-cacheable. A
      // plugin-scoped onSend covers reads, mutations and errors alike; no
      // shared HTTP cache or service-worker payload caching is introduced.
      reply.header("cache-control", "no-store");
    });

    app.addHook("preHandler", async (request, reply) => {
      if (request.auth.state !== "authenticated") {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Authentication is required." },
          requestId: request.id,
        });
      }
    });

    app.setErrorHandler((error: unknown, request, reply) => {
      const requestId = request.id;
      const err = error as { validation?: unknown; message?: string; statusCode?: number };
      if (err.validation !== undefined) {
        const message = err.message || "The request is invalid.";
        void reply.code(400).send({
          error: { code: "bad_request", message },
          requestId,
        });
        return;
      }
      const status = err.statusCode ?? 500;
      const code = status === 401 ? "unauthorized" : "internal";
      void reply.code(status).send({
        error: {
          code,
          message: status >= 500 ? "An internal error occurred." : (err.message ?? ""),
        },
        requestId,
      });
    });

    const ctxOf = (request: FastifyRequest) => ({
      actorId: request.auth.state === "authenticated" ? request.auth.actorId : "",
      requestId: request.id,
    });

    const sendError = (reply: FastifyReply, error: WireError, requestId: string) => {
      // Invalid inaccessible IDs collapse to not_found by the owning module;
      // the adapter never distinguishes unknown/revoked/expired tokens here.
      return reply.code(STATUS_BY_CODE[error.code as CampaignError["code"]] ?? 500).send({
        error: {
          code: error.code,
          message: error.code === "internal" ? "An internal error occurred." : error.message,
          ...(error.latestRevision === undefined || error.latestRevision === null
            ? {}
            : { latestRevision: error.latestRevision }),
        },
        requestId,
      });
    };

    const parsePageQuery = (
      request: FastifyRequest,
      reply: FastifyReply,
    ): { limit: number; cursor: string | null } | null => {
      const query = request.query as { limit?: string | number; cursor?: string } | undefined;
      const rawLimit = query?.limit;
      const limit = rawLimit === undefined ? 25 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
        return null;
      }
      return { limit, cursor: query?.cursor ?? null };
    };

    const toCampaignDto = (view: CampaignView): unknown => ({
      ...view,
      archivedAt: view.archivedAt === null ? null : view.archivedAt.toISOString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    });

    const toMemberDto = (member: MemberView): unknown => ({
      ...member,
      createdAt: member.createdAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
    });

    const toInvitationDto = (value: InvitationMetadata & { token?: string; tokenUnavailable?: true }): unknown => ({
      ...value,
      expiresAt: value.expiresAt.toISOString(),
    });

    const toReviewDto = (review: InvitationReview): unknown => ({
      ...review,
      expiresAt: review.expiresAt.toISOString(),
    });

    const toAcceptDto = (value: InvitationAcceptSuccess): unknown => ({
      ...value,
      membership: toMemberDto(value.membership),
    });

    const toDeclineDto = (value: InvitationDeclineSuccess): unknown => value;

    const toInvitationListItemDto = (item: InvitationListItem): unknown => ({
      ...item,
      expiresAt: item.expiresAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
    });

    const toContentDto = (view: ContentView): unknown => ({
      ...view,
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
      deletedAt: view.deletedAt === null ? null : view.deletedAt.toISOString(),
    });

    /**
     * Caller-owned placement transaction. The adapter owns BEGIN/COMMIT only;
     * lock ordering (campaign first, then characters by ID) stays inside the
     * placement operation, so Campaigns alone orders membership/placement
     * transactions. Any non-ok outcome rolls back: failed attempts leave no
     * pending idempotency rows behind.
     */
    const inPlacementTransaction = async <T>(
      work: (client: PoolClient) => Promise<{ result: T; commit: boolean }>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const outcome = await work(client);
          if (outcome.commit) {
            await client.query("COMMIT");
          } else {
            await client.query("ROLLBACK");
          }
          return outcome.result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      } finally {
        client.release();
      }
    };

    /**
     * Resolves the caller's active membership generation inside the placement
     * transaction. The generation is a server-side precondition (spec Section
     * 6 names only campaign/character revisions on the wire); removed members
     * and outsiders collapse to not_found without leaking campaign state.
     */
    const loadActiveMembershipGeneration = async (
      client: PoolClient,
      campaignId: string,
      actorId: string,
    ): Promise<number | null> => {
      const result = await client.query<{ generation: number }>(
        `SELECT generation FROM campaign_members
          WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
        [campaignId, actorId],
      );
      return result.rows[0]?.generation ?? null;
    };

    /**
     * Composes the full Characters view after a placement transaction
     * commits. Reads run outside the transaction through the owning
     * Characters entry point, so the response carries the same projection
     * shape as standalone reads under current campaign authorization.
     */
    const openPlacedCharacter = async (
      request: FastifyRequest,
      reply: FastifyReply,
      characterId: string,
    ): Promise<unknown | null> => {
      const opened = await characters.open(ctxOf(request), characterId);
      if (!opened.ok) {
        sendError(reply, internal(), request.id);
        return null;
      }
      return toCharacterViewDto(opened.value);
    };

    const runPlacementMutation = async (
      request: FastifyRequest,
      reply: FastifyReply,
      campaignId: string,
      mutate: (
        client: PoolClient,
        ctx: { actorId: string; requestId: string },
        membershipGeneration: number,
      ) => Promise<{ ok: true; value: PlacedCharacterView } | { ok: false; error: WireError }>,
    ): Promise<{ characterId: string } | null> => {
      const ctx = ctxOf(request);
      let outcome: { ok: true; value: PlacedCharacterView } | { ok: false; error: WireError };
      try {
        outcome = await inPlacementTransaction(async (client) => {
          const generation = await loadActiveMembershipGeneration(client, campaignId, ctx.actorId);
          if (generation === null) {
            return { result: { ok: false as const, error: notFound() }, commit: false };
          }
          const result = await mutate(client, ctx, generation);
          return { result, commit: result.ok };
        });
      } catch {
        sendError(reply, internal(), request.id);
        return null;
      }
      if (!outcome.ok) {
        sendError(reply, outcome.error, request.id);
        return null;
      }
      return { characterId: outcome.value.characterId };
    };

    type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
    const handlers: Record<string, Handler> = {
      post_campaigns: async (request, reply) => {
        const body = request.body as {
          systemVersionId: string;
          title: string;
          description?: string;
          idempotencyKey: string;
        };
        const result = await campaigns.create(ctxOf(request), {
          systemVersionId: body.systemVersionId,
          title: body.title,
          ...(body.description === undefined ? {} : { description: body.description }),
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ campaign: toCampaignDto(result.value), requestId: request.id });
      },

      get_campaigns: async (request, reply) => {
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.list(ctxOf(request), { limit: page.limit, cursor: page.cursor });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          campaigns: result.value.campaigns.map((summary) => ({
            ...summary,
            updatedAt: summary.updatedAt.toISOString(),
          })),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      get_campaigns_id: async (request, reply) => {
        const params = request.params as { id: string };
        const result = await campaigns.open(ctxOf(request), { campaignId: params.id });
        if (!result.ok) return sendError(reply, result.error, request.id);
        const view = result.value;
        // Authorize-before-conditional: the ETag identifies the current
        // policy revision, but no 304 path exists — every conditional-capable
        // read re-authorizes first, so a revoked actor never gets 304.
        reply.header("etag", `"campaign-${view.revision}-${view.accessRevision}"`);
        return { campaign: toCampaignDto(view), requestId: request.id };
      },

      patch_campaigns_id: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          title?: string;
          description?: string;
          expectedCampaignRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.update(ctxOf(request), {
          campaignId: params.id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { campaign: toCampaignDto(result.value), requestId: request.id };
      },

      post_campaigns_id_archive: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as { expectedCampaignRevision: number; idempotencyKey: string };
        const result = await campaigns.archive(ctxOf(request), {
          campaignId: params.id,
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { campaign: toCampaignDto(result.value), requestId: request.id };
      },

      post_campaigns_id_recover: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as { expectedCampaignRevision: number; idempotencyKey: string };
        const result = await campaigns.recover(ctxOf(request), {
          campaignId: params.id,
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { campaign: toCampaignDto(result.value), requestId: request.id };
      },

      get_campaigns_id_members: async (request, reply) => {
        const params = request.params as { id: string };
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.listMembers(ctxOf(request), {
          campaignId: params.id,
          limit: page.limit,
          cursor: page.cursor,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          members: result.value.members.map(toMemberDto),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      patch_campaigns_id_members_userId: async (request, reply) => {
        const params = request.params as { id: string; userId: string };
        const body = request.body as {
          role: "co_gm" | "player";
          expectedCampaignRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.changeRole(ctxOf(request), {
          campaignId: params.id,
          userId: params.userId,
          role: body.role,
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { member: toMemberDto(result.value), requestId: request.id };
      },

      delete_campaigns_id_members_userId: async (request, reply) => {
        const params = request.params as { id: string; userId: string };
        const body = request.body as { expectedCampaignRevision: number; idempotencyKey: string } | undefined;
        if (body?.expectedCampaignRevision === undefined || body?.idempotencyKey === undefined) {
          return sendError(
            reply,
            badRequest("expectedCampaignRevision and idempotencyKey are required in the request body."),
            request.id,
          );
        }
        const result = await campaigns.removeMember(ctxOf(request), {
          campaignId: params.id,
          userId: params.userId,
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { member: toMemberDto(result.value), requestId: request.id };
      },

      post_campaigns_id_invitations: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          intendedRole: "player" | "co_gm";
          expiresAt?: string;
          expectedCampaignRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.issueInvitation(ctxOf(request), {
          campaignId: params.id,
          intendedRole: body.intendedRole,
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ invitation: toInvitationDto(result.value), requestId: request.id });
      },

      get_campaigns_id_invitations: async (request, reply) => {
        const params = request.params as { id: string };
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.listInvitations(ctxOf(request), {
          campaignId: params.id,
          limit: page.limit,
          cursor: page.cursor,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          invitations: result.value.invitations.map(toInvitationListItemDto),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      post_campaigns_id_invitations_inviteId_rotate: async (request, reply) => {
        const params = request.params as { id: string; inviteId: string };
        const body = request.body as {
          expectedInvitationRevision: number;
          expectedCampaignRevision: number;
          expiresAt?: string;
          idempotencyKey: string;
        };
        const result = await campaigns.rotateInvitation(ctxOf(request), {
          campaignId: params.id,
          invitationId: params.inviteId,
          expectedInvitationRevision: body.expectedInvitationRevision,
          expectedCampaignRevision: body.expectedCampaignRevision,
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { invitation: toInvitationDto(result.value), requestId: request.id };
      },

      post_campaigns_id_invitations_inviteId_revoke: async (request, reply) => {
        const params = request.params as { id: string; inviteId: string };
        const body = request.body as {
          expectedInvitationRevision: number;
          expectedCampaignRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.revokeInvitation(ctxOf(request), {
          campaignId: params.id,
          invitationId: params.inviteId,
          expectedInvitationRevision: body.expectedInvitationRevision,
          expectedCampaignRevision: body.expectedCampaignRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { invitation: toInvitationDto(result.value), requestId: request.id };
      },

      post_invitations_review: async (request, reply) => {
        const body = request.body as { token: string };
        const result = await campaigns.reviewInvitation(ctxOf(request), { token: body.token });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { review: toReviewDto(result.value), requestId: request.id };
      },

      post_invitations_accept: async (request, reply) => {
        const body = request.body as {
          campaignId: string;
          token: string;
          expectedInvitationRevision: number;
          reviewedAccessRevision: number;
          idempotencyKey: string;
        };
        // Accept/decline are built from the review's revisions alone: a
        // nonmember holds no campaign revision, and none is required.
        const result = await campaigns.acceptInvitation(ctxOf(request), {
          campaignId: body.campaignId,
          token: body.token,
          expectedInvitationRevision: body.expectedInvitationRevision,
          reviewedAccessRevision: body.reviewedAccessRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { acceptance: toAcceptDto(result.value), requestId: request.id };
      },

      post_invitations_decline: async (request, reply) => {
        const body = request.body as {
          campaignId: string;
          token: string;
          expectedInvitationRevision: number;
          reviewedAccessRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.declineInvitation(ctxOf(request), {
          campaignId: body.campaignId,
          token: body.token,
          expectedInvitationRevision: body.expectedInvitationRevision,
          reviewedAccessRevision: body.reviewedAccessRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { declination: toDeclineDto(result.value), requestId: request.id };
      },

      get_campaigns_id_characters: async (request, reply) => {
        const params = request.params as { id: string };
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.listCharacters(ctxOf(request), {
          campaignId: params.id,
          limit: page.limit,
          cursor: page.cursor,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          characters: result.value.characters.map((summary) => ({
            ...summary,
            updatedAt: summary.updatedAt.toISOString(),
          })),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      post_campaigns_id_characters: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          name: string;
          entityDefinitionId: string;
          initialValues?: Record<string, unknown>;
          controllerUserIds?: string[];
          expectedCampaignRevision: number;
          idempotencyKey: string;
        };
        const ctx = ctxOf(request);
        // Opening first both authorizes the caller and pins the campaign
        // version; outsiders collapse to not_found before any Runtime work.
        const opened = await campaigns.open(ctx, { campaignId: params.id });
        if (!opened.ok) return sendError(reply, opened.error, request.id);
        // Runtime preparation stays outside any transaction (Task 4
        // discipline); createInCampaign only rechecks and persists it.
        const prepared = await prepareCampaignCharacter(runtime, {
          systemVersionId: opened.value.systemVersionId,
          entityDefinitionId: body.entityDefinitionId,
          ...(body.initialValues === undefined ? {} : { initialValues: body.initialValues }),
        });
        if (!prepared.ok) {
          return sendError(reply, prepared.error, request.id);
        }
        const placed = await runPlacementMutation(request, reply, params.id, (client, mutationCtx, generation) =>
          placement.createInCampaign(client, mutationCtx, {
            campaignId: params.id,
            expectedCampaignRevision: body.expectedCampaignRevision,
            membershipGeneration: generation,
            idempotencyKey: body.idempotencyKey,
            name: body.name,
            entityDefinitionId: body.entityDefinitionId,
            prepared: prepared.value,
            ...(body.controllerUserIds === undefined ? {} : { controllerUserIds: body.controllerUserIds }),
          }),
        );
        if (placed === null) return null;
        const character = await openPlacedCharacter(request, reply, placed.characterId);
        if (character === null) return null;
        return reply.code(201).send({ character, requestId: request.id });
      },

      post_campaigns_id_characters_characterId_assign: async (request, reply) => {
        const params = request.params as { id: string; characterId: string };
        const body = request.body as {
          controllerUserIds: string[];
          designateClaimants?: string[];
          expectedCampaignRevision: number;
          expectedCharacterRevision: number;
          idempotencyKey: string;
        };
        const placed = await runPlacementMutation(request, reply, params.id, (client, mutationCtx, generation) =>
          placement.assign(client, mutationCtx, {
            campaignId: params.id,
            expectedCampaignRevision: body.expectedCampaignRevision,
            membershipGeneration: generation,
            characterId: params.characterId,
            expectedCharacterRevision: body.expectedCharacterRevision,
            controllerUserIds: body.controllerUserIds,
            ...(body.designateClaimants === undefined ? {} : { designateClaimants: body.designateClaimants }),
            idempotencyKey: body.idempotencyKey,
          }),
        );
        if (placed === null) return null;
        const character = await openPlacedCharacter(request, reply, placed.characterId);
        if (character === null) return null;
        return { character, requestId: request.id };
      },

      post_campaigns_id_characters_characterId_claim: async (request, reply) => {
        const params = request.params as { id: string; characterId: string };
        const body = request.body as {
          expectedCampaignRevision: number;
          expectedCharacterRevision: number;
          idempotencyKey: string;
        };
        const placed = await runPlacementMutation(request, reply, params.id, (client, mutationCtx, generation) =>
          placement.claim(client, mutationCtx, {
            campaignId: params.id,
            expectedCampaignRevision: body.expectedCampaignRevision,
            membershipGeneration: generation,
            characterId: params.characterId,
            expectedCharacterRevision: body.expectedCharacterRevision,
            idempotencyKey: body.idempotencyKey,
          }),
        );
        if (placed === null) return null;
        const character = await openPlacedCharacter(request, reply, placed.characterId);
        if (character === null) return null;
        return { character, requestId: request.id };
      },

      post_campaigns_id_characters_characterId_adopt: async (request, reply) => {
        const params = request.params as { id: string; characterId: string };
        const body = request.body as {
          expectedCampaignRevision: number;
          expectedCharacterRevision: number;
          acknowledgedDisclosure: boolean;
          idempotencyKey: string;
        };
        const placed = await runPlacementMutation(request, reply, params.id, (client, mutationCtx, generation) =>
          placement.adopt(client, mutationCtx, {
            campaignId: params.id,
            expectedCampaignRevision: body.expectedCampaignRevision,
            membershipGeneration: generation,
            characterId: params.characterId,
            expectedCharacterRevision: body.expectedCharacterRevision,
            acknowledgedDisclosure: body.acknowledgedDisclosure,
            idempotencyKey: body.idempotencyKey,
          }),
        );
        if (placed === null) return null;
        const character = await openPlacedCharacter(request, reply, placed.characterId);
        if (character === null) return null;
        return { character, requestId: request.id };
      },

      get_campaigns_id_content: async (request, reply) => {
        const params = request.params as { id: string };
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.listContent(ctxOf(request), {
          campaignId: params.id,
          limit: page.limit,
          cursor: page.cursor,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          content: result.value.content.map((summary) => ({
            ...summary,
            createdAt: summary.createdAt.toISOString(),
            updatedAt: summary.updatedAt.toISOString(),
          })),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      post_campaigns_id_content: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          title?: string;
          body?: string;
          tags?: string[];
          audience?: "gm_only" | "all_players" | "selected_players" | "owner_only";
          grantedUserIds?: string[];
          idempotencyKey: string;
        };
        const result = await campaigns.createContent(ctxOf(request), {
          campaignId: params.id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.body === undefined ? {} : { body: body.body }),
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.audience === undefined ? {} : { audience: body.audience }),
          ...(body.grantedUserIds === undefined ? {} : { grantedUserIds: body.grantedUserIds }),
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ content: toContentDto(result.value), requestId: request.id });
      },

      get_content_id: async (request, reply) => {
        const params = request.params as { id: string };
        const result = await campaigns.openContent(ctxOf(request), { contentId: params.id });
        if (!result.ok) return sendError(reply, result.error, request.id);
        const view = result.value;
        reply.header("etag", `"content-${view.revision}-${view.accessRevision}"`);
        return { content: toContentDto(view), requestId: request.id };
      },

      patch_content_id: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          title?: string;
          body?: string;
          tags?: string[];
          audience?: "gm_only" | "all_players" | "selected_players" | "owner_only";
          expectedContentRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.updateContent(ctxOf(request), {
          contentId: params.id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.body === undefined ? {} : { body: body.body }),
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.audience === undefined ? {} : { audience: body.audience }),
          expectedContentRevision: body.expectedContentRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { content: toContentDto(result.value), requestId: request.id };
      },

      delete_content_id: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as { expectedContentRevision: number; idempotencyKey: string } | undefined;
        if (body?.expectedContentRevision === undefined || body?.idempotencyKey === undefined) {
          return sendError(
            reply,
            badRequest("expectedContentRevision and idempotencyKey are required in the request body."),
            request.id,
          );
        }
        const result = await campaigns.deleteContent(ctxOf(request), {
          contentId: params.id,
          expectedContentRevision: body.expectedContentRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { content: toContentDto(result.value), requestId: request.id };
      },

      post_content_id_grants: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as {
          grantedUserIds: string[];
          expectedContentRevision: number;
          idempotencyKey: string;
        };
        const result = await campaigns.replaceGrants(ctxOf(request), {
          contentId: params.id,
          grantedUserIds: body.grantedUserIds,
          expectedContentRevision: body.expectedContentRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { content: toContentDto(result.value), requestId: request.id };
      },

      post_content_id_recover: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as { expectedContentRevision: number; idempotencyKey: string } | undefined;
        if (body?.expectedContentRevision === undefined || body?.idempotencyKey === undefined) {
          return sendError(
            reply,
            badRequest("expectedContentRevision and idempotencyKey are required in the request body."),
            request.id,
          );
        }
        const result = await campaigns.recoverContent(ctxOf(request), {
          contentId: params.id,
          expectedContentRevision: body.expectedContentRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { content: toContentDto(result.value), requestId: request.id };
      },

      get_campaigns_id_activity: async (request, reply) => {
        const params = request.params as { id: string };
        const page = parsePageQuery(request, reply);
        if (page === null) return null;
        const result = await campaigns.listActivity(ctxOf(request), {
          campaignId: params.id,
          limit: page.limit,
          cursor: page.cursor,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return {
          events: result.value.events.map((event) => ({
            ...event,
            occurredAt: event.occurredAt.toISOString(),
          })),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      post_campaigns_id_exports: async (request, reply) => {
        const params = request.params as { id: string };
        const body = request.body as { idempotencyKey: string };
        const result = await campaigns.exportCampaign(ctxOf(request), {
          campaignId: params.id,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { export: result.value, requestId: request.id };
      },
    };

    for (const route of campaignsRouteDefinitions) {
      const response = toFastifyResponses(route.schema.response);
      const schema = response === undefined ? route.schema : { ...route.schema, response };
      app[route.method](route.path, { schema }, handlers[route.operationId]!);
    }
  };
