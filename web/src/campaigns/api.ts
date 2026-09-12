import type { ApiClient } from "../api/client.js";
import type {
  CampaignActivityResponse,
  CampaignCharacterListResponse,
  CampaignContentListResponse,
  CampaignContentResponse,
  CampaignLifecycleBody,
  CampaignListResponse,
  CampaignViewResponse,
  ChangeMemberRoleBody,
  CreateCampaignBody,
  CreateCampaignResponse,
  CreateContentBody,
  CreateContentResponse,
  DeleteContentBody,
  DeleteContentResponse,
  ExportCampaignBody,
  ExportCampaignResponse,
  InvitationAcceptBody,
  InvitationAcceptResponse,
  InvitationListResponse,
  InvitationReviewResponse,
  IssueInvitationBody,
  IssueInvitationResponse,
  RecoverContentBody,
  RemoveMemberBody,
  ReplaceGrantsBody,
  RevokeInvitationBody,
  RotateInvitationBody,
  UpdateCampaignBody,
  UpdateContentBody,
  MemberListResponse,
} from "./types.js";
import type { operations } from "../api/schema.js";

export type CampaignListQuery = { cursor?: string | null; limit?: number };
export type ReviewInvitationBody = { token: string };
export type DeclineInvitationBody = {
  campaignId: string;
  token: string;
  expectedInvitationRevision: number;
  reviewedAccessRevision: number;
  idempotencyKey: string;
};
export type ClaimCharacterBody = {
  expectedCampaignRevision: number;
  expectedCharacterRevision: number;
  idempotencyKey: string;
};
export type CreateCampaignCharacterBody = NonNullable<
  operations["post_campaigns_id_characters"]["requestBody"]
>["content"]["application/json"];
export type CreateCampaignCharacterResponse =
  operations["post_campaigns_id_characters"]["responses"]["201"]["content"]["application/json"];

type ReviewBody = NonNullable<
  operations["post_invitations_review"]["requestBody"]
>["content"]["application/json"];
type DeclineResponse =
  operations["post_invitations_decline"]["responses"]["200"]["content"]["application/json"];
export type ContentListQuery = { cursor?: string | null; limit?: number };
export type ActivityListQuery = { cursor?: string | null; limit?: number };

export type CampaignsApi = {
  listCampaigns(input?: CampaignListQuery): Promise<CampaignListResponse>;
  openCampaign(campaignId: string): Promise<CampaignViewResponse>;
  reviewInvitation(body: ReviewInvitationBody): Promise<InvitationReviewResponse>;
  acceptInvitation(body: InvitationAcceptBody): Promise<InvitationAcceptResponse>;
  declineInvitation(body: DeclineInvitationBody): Promise<DeclineResponse>;
  leaveCampaign(campaignId: string, memberUserId: string, body: { expectedCampaignRevision: number; idempotencyKey: string }): Promise<unknown>;
  listCampaignCharacters(campaignId: string, input?: CampaignListQuery): Promise<CampaignCharacterListResponse>;
  claimCharacter(campaignId: string, characterId: string, body: ClaimCharacterBody): Promise<unknown>;
  createCampaignCharacter(campaignId: string, body: CreateCampaignCharacterBody): Promise<CreateCampaignCharacterResponse>;
  listContent(campaignId: string, input?: ContentListQuery): Promise<CampaignContentListResponse>;
  openContent(contentId: string): Promise<CampaignContentResponse>;
  listActivity(campaignId: string, input?: ActivityListQuery): Promise<CampaignActivityResponse>;
  createCampaign(body: CreateCampaignBody): Promise<CreateCampaignResponse>;
  updateCampaign(campaignId: string, body: UpdateCampaignBody): Promise<CampaignViewResponse>;
  archiveCampaign(campaignId: string, body: CampaignLifecycleBody): Promise<CampaignViewResponse>;
  recoverCampaign(campaignId: string, body: CampaignLifecycleBody): Promise<CampaignViewResponse>;
  exportCampaign(campaignId: string, body: ExportCampaignBody): Promise<ExportCampaignResponse>;
  listMembers(campaignId: string, input?: CampaignListQuery): Promise<MemberListResponse>;
  changeMemberRole(campaignId: string, memberUserId: string, body: ChangeMemberRoleBody): Promise<unknown>;
  removeMember(campaignId: string, memberUserId: string, body: RemoveMemberBody): Promise<unknown>;
  listInvitations(campaignId: string, input?: CampaignListQuery): Promise<InvitationListResponse>;
  issueInvitation(campaignId: string, body: IssueInvitationBody): Promise<IssueInvitationResponse>;
  rotateInvitation(campaignId: string, inviteId: string, body: RotateInvitationBody): Promise<IssueInvitationResponse>;
  revokeInvitation(campaignId: string, inviteId: string, body: RevokeInvitationBody): Promise<unknown>;
  createContent(campaignId: string, body: CreateContentBody): Promise<CreateContentResponse>;
  updateContent(contentId: string, body: UpdateContentBody): Promise<CampaignContentResponse>;
  deleteContent(contentId: string, body: DeleteContentBody): Promise<DeleteContentResponse>;
  recoverContent(contentId: string, body: RecoverContentBody): Promise<unknown>;
  replaceContentGrants(contentId: string, body: ReplaceGrantsBody): Promise<unknown>;
};

export function createCampaignsApi(client: ApiClient): CampaignsApi {
  return {
    listCampaigns: (input) =>
      input === undefined
        ? client.fetch<CampaignListResponse>("GET", "/campaigns")
        : client.fetch<CampaignListResponse>("GET", "/campaigns", {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    openCampaign: (campaignId) =>
      client.fetch<CampaignViewResponse>("GET", `/campaigns/${campaignId}`),
    reviewInvitation: (body) =>
      client.fetch<InvitationReviewResponse>("POST", "/invitations/review", {
        body: body as ReviewBody,
      }),
    acceptInvitation: (body) =>
      client.fetch<InvitationAcceptResponse>("POST", "/invitations/accept", { body }),
    declineInvitation: (body) =>
      client.fetch<DeclineResponse>("POST", "/invitations/decline", { body }),
    leaveCampaign: (campaignId, memberUserId, body) =>
      client.fetch("DELETE", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    listCampaignCharacters: (campaignId, input) =>
      input === undefined
        ? client.fetch<CampaignCharacterListResponse>("GET", `/campaigns/${campaignId}/characters`)
        : client.fetch<CampaignCharacterListResponse>("GET", `/campaigns/${campaignId}/characters`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    claimCharacter: (campaignId, characterId, body) =>
      client.fetch("POST", `/campaigns/${campaignId}/characters/${characterId}/claim`, { body }),
    createCampaignCharacter: (campaignId, body) =>
      client.fetch<CreateCampaignCharacterResponse>("POST", `/campaigns/${campaignId}/characters`, { body }),
    listContent: (campaignId, input) =>
      input === undefined
        ? client.fetch<CampaignContentListResponse>("GET", `/campaigns/${campaignId}/content`)
        : client.fetch<CampaignContentListResponse>("GET", `/campaigns/${campaignId}/content`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    openContent: (contentId) =>
      client.fetch<CampaignContentResponse>("GET", `/content/${contentId}`),
    listActivity: (campaignId, input) =>
      input === undefined
        ? client.fetch<CampaignActivityResponse>("GET", `/campaigns/${campaignId}/activity`)
        : client.fetch<CampaignActivityResponse>("GET", `/campaigns/${campaignId}/activity`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    createCampaign: (body) =>
      client.fetch<CreateCampaignResponse>("POST", "/campaigns", { body }),
    updateCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("PATCH", `/campaigns/${campaignId}`, { body }),
    archiveCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("POST", `/campaigns/${campaignId}/archive`, { body }),
    recoverCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("POST", `/campaigns/${campaignId}/recover`, { body }),
    exportCampaign: (campaignId, body) =>
      client.fetch<ExportCampaignResponse>("POST", `/campaigns/${campaignId}/exports`, { body }),
    listMembers: (campaignId, input) =>
      input === undefined
        ? client.fetch<MemberListResponse>("GET", `/campaigns/${campaignId}/members`)
        : client.fetch<MemberListResponse>("GET", `/campaigns/${campaignId}/members`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    changeMemberRole: (campaignId, memberUserId, body) =>
      client.fetch("PATCH", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    removeMember: (campaignId, memberUserId, body) =>
      client.fetch("DELETE", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    listInvitations: (campaignId, input) =>
      input === undefined
        ? client.fetch<InvitationListResponse>("GET", `/campaigns/${campaignId}/invitations`)
        : client.fetch<InvitationListResponse>("GET", `/campaigns/${campaignId}/invitations`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    issueInvitation: (campaignId, body) =>
      client.fetch<IssueInvitationResponse>("POST", `/campaigns/${campaignId}/invitations`, { body }),
    rotateInvitation: (campaignId, inviteId, body) =>
      client.fetch<IssueInvitationResponse>("POST", `/campaigns/${campaignId}/invitations/${inviteId}/rotate`, { body }),
    revokeInvitation: (campaignId, inviteId, body) =>
      client.fetch("POST", `/campaigns/${campaignId}/invitations/${inviteId}/revoke`, { body }),
    createContent: (campaignId, body) =>
      client.fetch<CreateContentResponse>("POST", `/campaigns/${campaignId}/content`, { body }),
    updateContent: (contentId, body) =>
      client.fetch<CampaignContentResponse>("PATCH", `/content/${contentId}`, { body }),
    deleteContent: (contentId, body) =>
      client.fetch<DeleteContentResponse>("DELETE", `/content/${contentId}`, { body }),
    recoverContent: (contentId, body) =>
      client.fetch("POST", `/content/${contentId}/recover`, { body }),
    replaceContentGrants: (contentId, body) =>
      client.fetch("POST", `/content/${contentId}/grants`, { body }),
  };
}
