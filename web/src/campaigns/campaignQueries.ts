import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery, ClaimableCharactersQuery } from "./api.js";
import type {
  ApplyFogEditBody,
  MoveTokenBody,
  PlaceTokenBody,
  RemoveTokenBody,
  UpdateSceneBody,
} from "./types.js";

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

/**
 * Preview-as-member cache family: ephemeral GM projection reads, keyed by
 * the preview target. Preview data never enters the GM content cache keys;
 * the Content tab purges this family on preview exit and on unmount.
 */
export function campaignContentPreviewKey(campaignId: string, targetUserId: string): string[] {
  return ["campaigns", "preview", campaignId, targetUserId];
}

export function campaignInvitationsKey(campaignId: string, actorId: string | null, generation: number) {
  return ["campaigns", "invitations", campaignId, actorId, generation];
}

export function sceneDetailKey(
  campaignId: string,
  sceneId: string,
  actorId: string | null,
  generation: number,
) {
  return ["campaigns", "scene", campaignId, sceneId, actorId, generation];
}

export function useScene(
  api: CampaignsApi,
  campaignId: string,
  sceneId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useQuery({
    queryKey: sceneDetailKey(campaignId, sceneId, actorId, generation),
    queryFn: () => api.openScene(sceneId),
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}

/**
 * Shared scene-commit invalidation: the campaign-wide scene prefix (every
 * actor/generation scoped scene read under this campaign reloads). Paired
 * displays receive committed changes through the scene event stream.
 */
function invalidateSceneReads(
  queryClient: ReturnType<typeof useQueryClient>,
  campaignId: string,
  sceneId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["campaigns", "scene", campaignId] });
}

export function useUpdateScene(api: CampaignsApi, campaignId: string, sceneId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSceneBody) => api.updateScene(sceneId, body),
    onSuccess: () => {
      invalidateSceneReads(queryClient, campaignId, sceneId);
    },
  });
}

export function useApplyFogEdit(api: CampaignsApi, campaignId: string, sceneId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApplyFogEditBody) => api.applyFogEdit(sceneId, body),
    onSuccess: () => {
      invalidateSceneReads(queryClient, campaignId, sceneId);
    },
  });
}

export function usePlaceToken(api: CampaignsApi, campaignId: string, sceneId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PlaceTokenBody) => api.placeToken(sceneId, body),
    onSuccess: () => {
      invalidateSceneReads(queryClient, campaignId, sceneId);
    },
  });
}

export function useMoveToken(api: CampaignsApi, campaignId: string, sceneId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { tokenId: string; body: MoveTokenBody }) =>
      api.moveToken(sceneId, input.tokenId, input.body),
    onSuccess: () => {
      invalidateSceneReads(queryClient, campaignId, sceneId);
    },
  });
}

export function useRemoveToken(api: CampaignsApi, campaignId: string, sceneId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { tokenId: string; body: RemoveTokenBody }) =>
      api.removeToken(sceneId, input.tokenId, input.body),
    onSuccess: () => {
      invalidateSceneReads(queryClient, campaignId, sceneId);
    },
  });
}

export function useRevokeDisplay(api: CampaignsApi, campaignId: string) {
  // The server ends the revoked display's scene stream; no display-side
  // cache exists to purge here.
  return useMutation({
    mutationFn: (displayId: string) => api.revokeDisplay(campaignId, displayId),
  });
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
