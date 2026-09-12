import type { operations } from "../api/schema.js";

export type CampaignListResponse =
  operations["get_campaigns"]["responses"]["200"]["content"]["application/json"];
export type CampaignSummary = CampaignListResponse["campaigns"][number];

export type CampaignViewResponse =
  operations["get_campaigns_id"]["responses"]["200"]["content"]["application/json"];
export type CampaignView = CampaignViewResponse["campaign"];

export type InvitationReviewResponse =
  operations["post_invitations_review"]["responses"]["200"]["content"]["application/json"];
export type InvitationReview = InvitationReviewResponse["review"];

export type InvitationAcceptBody = NonNullable<
  operations["post_invitations_accept"]["requestBody"]
>["content"]["application/json"];
export type InvitationAcceptResponse =
  operations["post_invitations_accept"]["responses"]["200"]["content"]["application/json"];

export type CampaignCharacterListResponse =
  operations["get_campaigns_id_characters"]["responses"]["200"]["content"]["application/json"];
export type CampaignCharacterSummary = CampaignCharacterListResponse["characters"][number];

export type CampaignContentListResponse =
  operations["get_campaigns_id_content"]["responses"]["200"]["content"]["application/json"];
export type ContentSummary = CampaignContentListResponse["content"][number];

export type CampaignContentResponse =
  operations["get_content_id"]["responses"]["200"]["content"]["application/json"];
export type ContentView = CampaignContentResponse["content"];

export type CampaignActivityResponse =
  operations["get_campaigns_id_activity"]["responses"]["200"]["content"]["application/json"];
export type CampaignActivityEvent = CampaignActivityResponse["events"][number];

export type CreateCampaignBody = NonNullable<
  operations["post_campaigns"]["requestBody"]
>["content"]["application/json"];
export type CreateCampaignResponse =
  operations["post_campaigns"]["responses"]["201"]["content"]["application/json"];

export type UpdateCampaignBody = NonNullable<
  operations["patch_campaigns_id"]["requestBody"]
>["content"]["application/json"];

export type CampaignLifecycleBody = NonNullable<
  operations["post_campaigns_id_archive"]["requestBody"]
>["content"]["application/json"];

export type ExportCampaignBody = NonNullable<
  operations["post_campaigns_id_exports"]["requestBody"]
>["content"]["application/json"];
export type ExportCampaignResponse =
  operations["post_campaigns_id_exports"]["responses"]["200"]["content"]["application/json"];

export type MemberListResponse =
  operations["get_campaigns_id_members"]["responses"]["200"]["content"]["application/json"];
export type CampaignMember = MemberListResponse["members"][number];

export type ChangeMemberRoleBody = NonNullable<
  operations["patch_campaigns_id_members_userId"]["requestBody"]
>["content"]["application/json"];
export type RemoveMemberBody = NonNullable<
  operations["delete_campaigns_id_members_userId"]["requestBody"]
>["content"]["application/json"];

export type InvitationListResponse =
  operations["get_campaigns_id_invitations"]["responses"]["200"]["content"]["application/json"];
export type InvitationSummary = InvitationListResponse["invitations"][number];

export type IssueInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations"]["requestBody"]
>["content"]["application/json"];
export type IssueInvitationResponse =
  operations["post_campaigns_id_invitations"]["responses"]["201"]["content"]["application/json"];

export type RotateInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations_inviteId_rotate"]["requestBody"]
>["content"]["application/json"];
export type RevokeInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations_inviteId_revoke"]["requestBody"]
>["content"]["application/json"];
