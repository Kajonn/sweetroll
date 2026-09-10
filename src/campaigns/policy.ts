import type { CampaignRecord, ContentAudience, MembershipRecord } from "./persistence.js";

export type { ContentAudience, MembershipRecord };

/**
 * Task 2 policy base: current membership/role decisions for the campaign
 * aggregate. Audience, character placement capabilities and replay
 * authorization extend this module in later tasks.
 *
 * Campaign roles never authorize system draft read/write: every decision
 * below is scoped to campaign metadata/membership reads and mutations.
 * System authoring keeps its own owner-only authorization untouched.
 */
export function isActiveMember(membership: MembershipRecord | null): membership is MembershipRecord {
  return membership !== null && membership.status === "active";
}

export function isOwner(membership: MembershipRecord | null): boolean {
  return isActiveMember(membership) && membership.role === "owner";
}

export function isGameMaster(membership: MembershipRecord | null): boolean {
  return (
    isActiveMember(membership) && (membership.role === "owner" || membership.role === "co_gm")
  );
}

/** Active members may read campaign identity and roster. */
export function canReadCampaign(
  _campaign: CampaignRecord,
  membership: MembershipRecord | null,
): boolean {
  return isActiveMember(membership);
}

/** Only active owner/co-GMs may mutate metadata or lifecycle. */
export function canManageCampaign(
  campaign: CampaignRecord,
  membership: MembershipRecord | null,
): boolean {
  return campaign.status === "active" && isGameMaster(membership);
}

/** Archive/recover are revisioned owner/co-GM commands on any status. */
export function canChangeLifecycle(membership: MembershipRecord | null): boolean {
  return isGameMaster(membership);
}

/**
 * Role changes: the owner row is immutable, only the owner may
 * promote/demote co-GMs, and co-GMs may not modify peer co-GMs or the
 * owner. Returns null when the change is permitted.
 */
export function authorizeRoleChange(input: {
  caller: MembershipRecord | null;
  target: MembershipRecord | null;
  newRole: MembershipRecord["role"];
}): "not_member" | "not_manager" | "owner_immutable" | "owner_only" | null {
  if (!isActiveMember(input.caller)) return "not_member";
  if (input.target === null || input.target.status !== "active") return "not_member";
  if (!isGameMaster(input.caller)) return "not_manager";
  if (input.target.role === "owner") return "owner_immutable";
  if (input.newRole === "owner") return "owner_immutable";
  const touchesCoGm = input.target.role === "co_gm" || input.newRole === "co_gm";
  if (touchesCoGm && input.caller.role !== "owner") return "owner_only";
  return null;
}

/**
 * Removal: the owner can never be removed (not even by self; archive the
 * campaign instead), co-GMs cannot remove the owner or peer co-GMs, and a
 * player may remove only themselves. Returns null when permitted.
 */export function authorizeRemoval(input: {
  caller: MembershipRecord | null;
  target: MembershipRecord | null;
}): "not_member" | "not_manager" | "owner_immutable" | "owner_only" | "self_only" | null {
  if (!isActiveMember(input.caller)) return "not_member";
  if (input.target === null || input.target.status !== "active") return "not_member";
  if (input.target.role === "owner") return "owner_immutable";
  if (input.caller.userId === input.target.userId) return null;
  if (!isGameMaster(input.caller)) return "self_only";
  if (input.target.role === "co_gm" && input.caller.role !== "owner") return "owner_only";
  return null;
}

export type ContentRecordLike = {
  campaignId: string;
  creatorId: string;
  audience: ContentAudience;
  status: "active" | "deleted";
};

/**
 * Task 7 content visibility, evaluated against CURRENT content state
 * (audience, grants, soft-delete) on every read. The creator has no
 * standing once removed: every branch requires active membership,
 * including creator access. Soft-deleted rows are hidden from ordinary
 * reads; recovery reuses this same policy with the deletion ignored.
 */
export function canReadContent(input: {
  content: ContentRecordLike;
  membership: MembershipRecord | null;
  /** Active granted user IDs for selected_players content. */
  grantedUserIds: ReadonlySet<string>;
}): boolean {
  if (!isActiveMember(input.membership)) return false;
  switch (input.content.audience) {
    case "gm_only":
      return isGameMaster(input.membership);
    case "all_players":
      return true;
    case "selected_players":
      return isGameMaster(input.membership) || input.grantedUserIds.has(input.membership.userId);
    case "owner_only":
      return input.membership.userId === input.content.creatorId;
  }
}

/**
 * Edit/delete: the creator may manage their own notes while an active
 * member; GMs may manage content they can currently read. Nobody may act
 * on an inaccessible note by guessing its ID.
 */
export function canManageContent(input: {
  content: ContentRecordLike;
  membership: MembershipRecord | null;
  grantedUserIds: ReadonlySet<string>;
}): boolean {
  if (!isActiveMember(input.membership)) return false;
  if (input.membership.userId === input.content.creatorId) return true;
  return isGameMaster(input.membership) && canReadContent(input);
}

/**
 * Sharing administration (audience changes, grant replacement) is GM-only
 * and additionally requires the GM to currently read the note: another
 * actor's inaccessible owner-only note cannot be shared by guessing its ID.
 */
export function canAdministerContentSharing(input: {
  content: ContentRecordLike;
  membership: MembershipRecord | null;
  grantedUserIds: ReadonlySet<string>;
}): boolean {
  return isGameMaster(input.membership) && canReadContent(input);
}

/** Campaign export is a GM-only authorized projection. */
export function canExportCampaign(membership: MembershipRecord | null): boolean {
  return isGameMaster(membership);
}
