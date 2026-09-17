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

export type ClaimableCharacterListResponse =
  operations["get_campaigns_id_claimable_characters"]["responses"]["200"]["content"]["application/json"];
export type ClaimableCharacterSummary = ClaimableCharacterListResponse["characters"][number];

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

export type CreateContentBody = NonNullable<
  operations["post_campaigns_id_content"]["requestBody"]
>["content"]["application/json"];
export type CreateContentResponse =
  operations["post_campaigns_id_content"]["responses"]["201"]["content"]["application/json"];

export type UpdateContentBody = NonNullable<
  operations["patch_content_id"]["requestBody"]
>["content"]["application/json"];

export type DeleteContentBody = NonNullable<
  operations["delete_content_id"]["requestBody"]
>["content"]["application/json"];
export type DeleteContentResponse =
  operations["delete_content_id"]["responses"]["200"]["content"]["application/json"];

export type RecoverContentBody = NonNullable<
  operations["post_content_id_recover"]["requestBody"]
>["content"]["application/json"];

export type ReplaceGrantsBody = NonNullable<
  operations["post_content_id_grants"]["requestBody"]
>["content"]["application/json"];

export type PreviewContentBody = NonNullable<
  operations["post_campaigns_id_content_preview"]["requestBody"]
>["content"]["application/json"];
export type PreviewContentResponse =
  operations["post_campaigns_id_content_preview"]["responses"]["200"]["content"]["application/json"];

export type PreviewUpgradeBody = NonNullable<
  operations["post_campaigns_id_upgrade_previews"]["requestBody"]
>["content"]["application/json"];
export type PreviewUpgradeResponse =
  operations["post_campaigns_id_upgrade_previews"]["responses"]["200"]["content"]["application/json"];
export type UpgradeCharacterPreview = PreviewUpgradeResponse["characters"][number];

export type CommitUpgradeBody = NonNullable<
  operations["post_campaigns_id_upgrade_commits"]["requestBody"]
>["content"]["application/json"];
export type CommitUpgradeResponse =
  operations["post_campaigns_id_upgrade_commits"]["responses"]["200"]["content"]["application/json"];

export type UploadImageBody = NonNullable<
  operations["post_campaigns_id_images"]["requestBody"]
>["content"]["application/json"];
export type UploadImageResponse =
  operations["post_campaigns_id_images"]["responses"]["200"]["content"]["application/json"];

export type DeleteImageBody = NonNullable<
  operations["delete_campaigns_id_images_fileId"]["requestBody"]
>["content"]["application/json"];
export type DeleteImageResponse =
  operations["delete_campaigns_id_images_fileId"]["responses"]["200"]["content"]["application/json"];

export type CreateSceneBody = NonNullable<
  operations["post_campaigns_id_scenes"]["requestBody"]
>["content"]["application/json"];
export type CreateSceneResponse =
  operations["post_campaigns_id_scenes"]["responses"]["201"]["content"]["application/json"];

export type SceneDetailResponse =
  operations["get_scenes_id"]["responses"]["200"]["content"]["application/json"];
export type SceneView = SceneDetailResponse["scene"];

export type UpdateSceneBody = NonNullable<
  operations["patch_scenes_id"]["requestBody"]
>["content"]["application/json"];
export type UpdateSceneResponse =
  operations["patch_scenes_id"]["responses"]["200"]["content"]["application/json"];

export type ApplyFogEditBody = NonNullable<
  operations["post_scenes_id_fog_edits"]["requestBody"]
>["content"]["application/json"];
export type ApplyFogEditResponse =
  operations["post_scenes_id_fog_edits"]["responses"]["200"]["content"]["application/json"];

export type PlaceTokenBody = NonNullable<
  operations["post_scenes_id_tokens"]["requestBody"]
>["content"]["application/json"];
export type PlaceTokenResponse =
  operations["post_scenes_id_tokens"]["responses"]["200"]["content"]["application/json"];

export type MoveTokenBody = NonNullable<
  operations["patch_scenes_id_tokens_tokenId"]["requestBody"]
>["content"]["application/json"];
export type MoveTokenResponse =
  operations["patch_scenes_id_tokens_tokenId"]["responses"]["200"]["content"]["application/json"];

export type RemoveTokenBody = NonNullable<
  operations["delete_scenes_id_tokens_tokenId"]["requestBody"]
>["content"]["application/json"];
export type RemoveTokenResponse =
  operations["delete_scenes_id_tokens_tokenId"]["responses"]["200"]["content"]["application/json"];

export type PairDisplayBody = NonNullable<
  operations["post_campaigns_id_display_codes"]["requestBody"]
>["content"]["application/json"];
export type PairDisplayResponse =
  operations["post_campaigns_id_display_codes"]["responses"]["200"]["content"]["application/json"];

export type DisplayCredentialsResponse =
  operations["get_campaigns_id_display_credentials"]["responses"]["200"]["content"]["application/json"];
export type DisplayCredentialSummary = DisplayCredentialsResponse["displays"][number];

export type RevokeDisplayBody = NonNullable<
  operations["post_campaigns_id_displays_displayId_revoke"]["requestBody"]
>["content"]["application/json"];
export type RevokeDisplayResponse =
  operations["post_campaigns_id_displays_displayId_revoke"]["responses"]["200"]["content"]["application/json"];

export type RedeemDisplayBody = NonNullable<
  operations["post_displays_redeem"]["requestBody"]
>["content"]["application/json"];
export type RedeemDisplayResponse =
  operations["post_displays_redeem"]["responses"]["200"]["content"]["application/json"];
export type RedeemedDisplay = RedeemDisplayResponse["display"];

export type DisplayProjectionResponse =
  operations["get_displays_id_scenes_sceneId_projection"]["responses"]["200"]["content"]["application/json"];
export type DisplayProjection = DisplayProjectionResponse["projection"];
