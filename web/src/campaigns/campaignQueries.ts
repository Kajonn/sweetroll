import { useInfiniteQuery } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery } from "./api.js";

export const CAMPAIGN_LIST_PAGE_LIMIT = 25;

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
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}
