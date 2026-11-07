import { t } from "../i18n/index.js";
import { useDebugMode } from "../ui/debugMode.js";

type NamedMember = { userId: string; displayName?: string | null };
const nameOf = (member: NamedMember) => member.displayName?.trim() || t("campaign.member.unnamed");

/** Only presentation changes; selectors and commands always retain full IDs. */
export function memberLabel(member: NamedMember, roster: readonly NamedMember[] = [], debug = false): string {
  const name = nameOf(member);
  if (debug) return `${name} (${member.userId})`;
  const duplicates = roster.filter(candidate => nameOf(candidate) === name);
  if (member.displayName?.trim() && duplicates.length <= 1) return name;
  const short = member.userId.slice(0, 8);
  const collision = duplicates.some(candidate => candidate.userId !== member.userId && candidate.userId.slice(0, 8) === short);
  return `${name} (${collision ? member.userId : short})`;
}

export function useMemberLabel(roster: readonly NamedMember[]) {
  const debug = useDebugMode();
  return (member: NamedMember) => memberLabel(member, roster, debug);
}
