import type { CampaignRecord, MembershipRecord } from "./persistence.js";

export type { MembershipRecord };

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
 */
export function authorizeRemoval(input: {
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
