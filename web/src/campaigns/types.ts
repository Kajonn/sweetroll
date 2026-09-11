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
