import { useInfiniteQuery } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery } from "./api.js";

export const CAMPAIGN_LIST_PAGE_LIMIT = 25;

export const CAMPAIGN_MEMBER_PAGE_LIMIT = 25;

export function campaignDetailKey(campaignId: string): string[] {
  return ["campaigns", "detail", campaignId];
}

export function campaignCharactersKey(campaignId: string): string[] {
  return ["campaigns", "characters", campaignId];
}

export function campaignListKey(actorId: string | null, generation: number) {
  return ["campaigns", "list", actorId, generation];
}

export function useCampaignList(
  api: CampaignsApi,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignListKey(actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const query: CampaignListQuery = { cursor: pageParam, limit: CAMPAIGN_LIST_PAGE_LIMIT };
      return api.listCampaigns(query);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}

export function campaignMembersKey(campaignId: string, actorId: string | null, generation: number) {
  return ["campaigns", "members", campaignId, actorId, generation];
}

export function campaignInvitationsKey(campaignId: string, actorId: string | null, generation: number) {
  return ["campaigns", "invitations", campaignId, actorId, generation];
}

function memberPageQuery(pageParam: string | null): CampaignListQuery {
  return { cursor: pageParam, limit: CAMPAIGN_MEMBER_PAGE_LIMIT };
}

export function useCampaignMembers(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignMembersKey(campaignId, actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listMembers(campaignId, memberPageQuery(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}

export function useCampaignInvitations(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignInvitationsKey(campaignId, actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listInvitations(campaignId, memberPageQuery(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}
