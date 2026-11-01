import { isActiveMember, isGameMaster } from "./policy.js";
import type { MembershipRecord } from "./persistence.js";
export type TemplateAudience = "all_players" | "gm_only" | "selected_players";
export type TemplateGrant = { userId: string; generation: number };
export type TemplateReadScope = {
  mode: "gm" | "member" | "placeable";
  readerKey: string;
  userId?: string;
  generation?: number;
};
export function templateReadScope(
  member: MembershipRecord,
  readerKey: string,
): TemplateReadScope {
  return {
    mode: isGameMaster(member) ? "gm" : "member",
    readerKey,
    userId: member.userId,
    generation: member.generation,
  };
}
export function canReadTemplate(
  template: {
    audience: TemplateAudience;
    status: string;
    grants: TemplateGrant[];
  },
  member: MembershipRecord | null,
): boolean {
  if (!isActiveMember(member)) return false;
  if (isGameMaster(member)) return true;
  return (
    template.status === "active" &&
    (template.audience === "all_players" ||
      (template.audience === "selected_players" &&
        template.grants.some(
          (g) =>
            g.userId === member.userId && g.generation === member.generation,
        )))
  );
}
export function canPlaceTemplate(template: {
  audience: string;
  status: string;
}): boolean {
  return template.audience === "all_players" && template.status === "active";
}
