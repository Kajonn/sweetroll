import type { ApiClient } from "../api/client.js";
import type {
  CampaignActivityResponse,
  CampaignCharacterListResponse,
  CampaignContentListResponse,
  CampaignContentResponse,
  CampaignListResponse,
  CampaignViewResponse,
  InvitationAcceptBody,
  InvitationAcceptResponse,
  InvitationReviewResponse,
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

type ReviewBody = NonNullable<
  operations["post_invitations_review"]["requestBody"]
>["content"]["application/json"];
type DeclineResponse =
  operations["post_invitations_decline"]["responses"]["200"]["content"]["application/json"];
type ContentListQuery = { cursor?: string | null; limit?: number };
type ActivityListQuery = { cursor?: string | null; limit?: number };

export type CampaignsApi = {
  listCampaigns(input?: CampaignListQuery): Promise<CampaignListResponse>;
  openCampaign(campaignId: string): Promise<CampaignViewResponse>;
  reviewInvitation(body: ReviewInvitationBody): Promise<InvitationReviewResponse>;
  acceptInvitation(body: InvitationAcceptBody): Promise<InvitationAcceptResponse>;
  declineInvitation(body: DeclineInvitationBody): Promise<DeclineResponse>;
  leaveCampaign(campaignId: string, memberUserId: string, body: { expectedCampaignRevision: number; idempotencyKey: string }): Promise<unknown>;
  listCampaignCharacters(campaignId: string, input?: CampaignListQuery): Promise<CampaignCharacterListResponse>;
  claimCharacter(campaignId: string, characterId: string, body: ClaimCharacterBody): Promise<unknown>;
  listContent(campaignId: string, input?: ContentListQuery): Promise<CampaignContentListResponse>;
  openContent(contentId: string): Promise<CampaignContentResponse>;
  listActivity(campaignId: string, input?: ActivityListQuery): Promise<CampaignActivityResponse>;
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
  };
}
