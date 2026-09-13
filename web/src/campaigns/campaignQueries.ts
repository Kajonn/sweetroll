import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery, ClaimableCharactersQuery } from "./api.js";
import type { CommitUpgradeBody } from "./types.js";

export const CAMPAIGN_LIST_PAGE_LIMIT = 25;
export const CLAIMABLE_CHARACTERS_PAGE_LIMIT = 25;

export const CAMPAIGN_MEMBER_PAGE_LIMIT = 25;

export function campaignDetailKey(campaignId: string): string[] {
  return ["campaigns", "detail", campaignId];
}

export function campaignCharactersKey(
  campaignId: string,
  actorId?: string | null,
  generation?: number,
): (string | number | null)[] {
  if (actorId === undefined || generation === undefined) {
    return ["campaigns", "characters", campaignId];
  }
  return ["campaigns", "characters", campaignId, actorId, generation];
}

export function campaignClaimableCharactersKey(
  campaignId: string,
  actorId: string | null,
  generation: number,
) {
  return ["campaigns", "claimable-characters", campaignId, actorId, generation];
}

export function campaignCharactersPrefix(campaignId: string): string[] {
  return ["campaigns", "characters", campaignId];
}

export function campaignListKey(actorId: string | null, generation: number) {
  return ["campaigns", "list", actorId, generation];
}

export function campaignUpgradePreviewKey(
  campaignId: string,
  actorId: string | null,
  generation: number,
  targetVersionId: string | null,
) {
  return ["campaigns", "upgrade-preview", campaignId, actorId, generation, targetVersionId];
}

export function useUpgradePreview(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  targetVersionId: string | null,
  options: { enabled: boolean; online: boolean },
) {
  return useQuery({
    queryKey: campaignUpgradePreviewKey(campaignId, actorId, generation, targetVersionId),
    queryFn: () => {
      if (targetVersionId === null) throw new Error("upgrade target missing");
      return api.previewUpgrade(campaignId, { targetVersionId });
    },
    enabled: options.enabled && options.online && actorId !== null && targetVersionId !== null,
    staleTime: 30_000,
  });
}

export function useCommitUpgrade(api: CampaignsApi, campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CommitUpgradeBody) => api.commitUpgrade(campaignId, body),
    onSuccess: () => {
      // Same literal 3-element prefixes CampaignDetail uses for
      // leave/revocation purges, so every actor/generation-scoped read under
      // this campaign reloads. Invalidate (not purge): the campaign still
      // exists and the view must re-read the moved pin.
      void queryClient.invalidateQueries({ queryKey: campaignCharactersPrefix(campaignId) });
      void queryClient.invalidateQueries({ queryKey: ["campaigns", "content", campaignId] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns", "activity", campaignId] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns", "session", campaignId] });
      void queryClient.invalidateQueries({ queryKey: campaignDetailKey(campaignId) });
    },
  });
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

export function useClaimableCharacters(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignClaimableCharactersKey(campaignId, actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const query: ClaimableCharactersQuery = { cursor: pageParam, limit: CLAIMABLE_CHARACTERS_PAGE_LIMIT };
      return api.listClaimableCharacters(campaignId, query);
    },
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
