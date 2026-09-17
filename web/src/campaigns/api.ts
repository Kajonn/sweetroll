import type { ApiClient } from "../api/client.js";
import type {
  ApplyFogEditBody,
  ApplyFogEditResponse,
  CampaignActivityResponse,
  CampaignCharacterListResponse,
  CampaignContentListResponse,
  CampaignContentResponse,
  CampaignLifecycleBody,
  CampaignListResponse,
  CampaignViewResponse,
  ChangeMemberRoleBody,
  ClaimableCharacterListResponse,
  CommitUpgradeBody,
  CommitUpgradeResponse,
  CreateCampaignBody,
  CreateCampaignResponse,
  CreateContentBody,
  CreateContentResponse,
  CreateSceneBody,
  CreateSceneResponse,
  DeleteContentBody,
  DeleteContentResponse,
  DeleteImageBody,
  DeleteImageResponse,
  DisplayCredentialsResponse,
  DisplayProjectionResponse,
  ExportCampaignBody,
  ExportCampaignResponse,
  InvitationAcceptBody,
  InvitationAcceptResponse,
  InvitationListResponse,
  InvitationReviewResponse,
  IssueInvitationBody,
  IssueInvitationResponse,
  MoveTokenBody,
  MoveTokenResponse,
  PairDisplayResponse,
  PlaceTokenBody,
  PlaceTokenResponse,
  PreviewContentBody,
  PreviewContentResponse,
  PreviewUpgradeBody,
  PreviewUpgradeResponse,
  RecoverContentBody,
  RedeemDisplayBody,
  RedeemDisplayResponse,
  RemoveMemberBody,
  RemoveTokenBody,
  RemoveTokenResponse,
  ReplaceGrantsBody,
  RevokeDisplayResponse,
  RevokeInvitationBody,
  RotateInvitationBody,
  SceneDetailResponse,
  UpdateCampaignBody,
  UpdateContentBody,
  UpdateSceneBody,
  UpdateSceneResponse,
  UploadImageBody,
  UploadImageResponse,
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
export type ContentListQuery = { cursor?: string | null; limit?: number; status?: "active" | "deleted" };
export type ClaimableCharactersQuery = { cursor?: string | null; limit?: number };
export type ActivityListQuery = { cursor?: string | null; limit?: number };

export type CampaignsApi = {
  listCampaigns(input?: CampaignListQuery): Promise<CampaignListResponse>;
  openCampaign(campaignId: string): Promise<CampaignViewResponse>;
  reviewInvitation(body: ReviewInvitationBody): Promise<InvitationReviewResponse>;
  acceptInvitation(body: InvitationAcceptBody): Promise<InvitationAcceptResponse>;
  declineInvitation(body: DeclineInvitationBody): Promise<DeclineResponse>;
  leaveCampaign(campaignId: string, memberUserId: string, body: { expectedCampaignRevision: number; idempotencyKey: string }): Promise<unknown>;
  listCampaignCharacters(campaignId: string, input?: CampaignListQuery): Promise<CampaignCharacterListResponse>;
  listClaimableCharacters(campaignId: string, input?: ClaimableCharactersQuery): Promise<ClaimableCharacterListResponse>;
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
  previewContent(campaignId: string, body: PreviewContentBody): Promise<PreviewContentResponse>;
  previewUpgrade(campaignId: string, body: PreviewUpgradeBody): Promise<PreviewUpgradeResponse>;
  commitUpgrade(campaignId: string, body: CommitUpgradeBody): Promise<CommitUpgradeResponse>;
  uploadImage(campaignId: string, body: UploadImageBody): Promise<UploadImageResponse>;
  deleteImage(campaignId: string, fileId: string, body: DeleteImageBody): Promise<DeleteImageResponse>;
  createScene(campaignId: string, body: CreateSceneBody): Promise<CreateSceneResponse>;
  openScene(sceneId: string): Promise<SceneDetailResponse>;
  updateScene(sceneId: string, body: UpdateSceneBody): Promise<UpdateSceneResponse>;
  applyFogEdit(sceneId: string, body: ApplyFogEditBody): Promise<ApplyFogEditResponse>;
  placeToken(sceneId: string, body: PlaceTokenBody): Promise<PlaceTokenResponse>;
  moveToken(sceneId: string, tokenId: string, body: MoveTokenBody): Promise<MoveTokenResponse>;
  removeToken(sceneId: string, tokenId: string, body: RemoveTokenBody): Promise<RemoveTokenResponse>;
  pairDisplay(campaignId: string): Promise<PairDisplayResponse>;
  listDisplayCredentials(campaignId: string): Promise<DisplayCredentialsResponse>;
  revokeDisplay(campaignId: string, displayId: string): Promise<RevokeDisplayResponse>;
  redeemDisplay(body: RedeemDisplayBody): Promise<RedeemDisplayResponse>;
  getDisplayProjection(displayId: string, sceneId: string, secret: string): Promise<DisplayProjectionResponse>;
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
    listClaimableCharacters: (campaignId, input) =>
      input === undefined
        ? client.fetch<ClaimableCharacterListResponse>("GET", `/campaigns/${campaignId}/claimable-characters`)
        : client.fetch<ClaimableCharacterListResponse>("GET", `/campaigns/${campaignId}/claimable-characters`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    listContent: (campaignId, input) =>
      input === undefined
        ? client.fetch<CampaignContentListResponse>("GET", `/campaigns/${campaignId}/content`)
        : client.fetch<CampaignContentListResponse>("GET", `/campaigns/${campaignId}/content`, {
          query: {
            cursor: input.cursor ?? undefined,
            limit: input.limit ?? undefined,
            status: input.status ?? undefined,
          },
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
    previewContent: (campaignId, body) =>
      client.fetch<PreviewContentResponse>("POST", `/campaigns/${campaignId}/content-preview`, { body }),
    previewUpgrade: (campaignId, body) =>
      client.fetch<PreviewUpgradeResponse>("POST", `/campaigns/${campaignId}/upgrade-previews`, { body }),
    commitUpgrade: (campaignId, body) =>
      client.fetch<CommitUpgradeResponse>("POST", `/campaigns/${campaignId}/upgrade-commits`, { body }),
    uploadImage: (campaignId, body) =>
      client.fetch<UploadImageResponse>("POST", `/campaigns/${campaignId}/images`, { body }),
    deleteImage: (campaignId, fileId, body) =>
      client.fetch<DeleteImageResponse>("DELETE", `/campaigns/${campaignId}/images/${fileId}`, { body }),
    createScene: (campaignId, body) =>
      client.fetch<CreateSceneResponse>("POST", `/campaigns/${campaignId}/scenes`, { body }),
    openScene: (sceneId) =>
      client.fetch<SceneDetailResponse>("GET", `/scenes/${sceneId}`),
    updateScene: (sceneId, body) =>
      client.fetch<UpdateSceneResponse>("PATCH", `/scenes/${sceneId}`, { body }),
    applyFogEdit: (sceneId, body) =>
      client.fetch<ApplyFogEditResponse>("POST", `/scenes/${sceneId}/fog-edits`, { body }),
    placeToken: (sceneId, body) =>
      client.fetch<PlaceTokenResponse>("POST", `/scenes/${sceneId}/tokens`, { body }),
    moveToken: (sceneId, tokenId, body) =>
      client.fetch<MoveTokenResponse>("PATCH", `/scenes/${sceneId}/tokens/${tokenId}`, { body }),
    removeToken: (sceneId, tokenId, body) =>
      client.fetch<RemoveTokenResponse>("DELETE", `/scenes/${sceneId}/tokens/${tokenId}`, { body }),
    pairDisplay: (campaignId) =>
      client.fetch<PairDisplayResponse>("POST", `/campaigns/${campaignId}/display-codes`, { body: {} }),
    listDisplayCredentials: (campaignId) =>
      client.fetch<DisplayCredentialsResponse>("GET", `/campaigns/${campaignId}/display-credentials`),
    revokeDisplay: (campaignId, displayId) =>
      client.fetch<RevokeDisplayResponse>("POST", `/campaigns/${campaignId}/displays/${displayId}/revoke`, { body: {} }),
    redeemDisplay: (body) =>
      client.fetch<RedeemDisplayResponse>("POST", "/displays/redeem", { body }),
    getDisplayProjection: (displayId, sceneId, secret) =>
      client.fetch<DisplayProjectionResponse>("GET", `/displays/${displayId}/scenes/${sceneId}/projection`, {
        headers: { "x-display-secret": secret },
      }),
  };
}
