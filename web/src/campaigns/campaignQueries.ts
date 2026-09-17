import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery, ClaimableCharactersQuery } from "./api.js";
import type {
  ApplyFogEditBody,
  CommitUpgradeBody,
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

export function displayProjectionKey(displayId: string, sceneId: string, revision: number) {
  return ["displays", "projection", displayId, sceneId, revision];
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

export function useDisplayProjection(
  api: CampaignsApi,
  displayId: string,
  sceneId: string,
  revision: number,
  secret: string | null,
  options: { enabled: boolean; online: boolean },
) {
  return useQuery({
    queryKey: displayProjectionKey(displayId, sceneId, revision),
    queryFn: () => {
      if (secret === null) throw new Error("display credential missing");
      return api.getDisplayProjection(displayId, sceneId, secret);
    },
    enabled: options.enabled && options.online && secret !== null,
    staleTime: 30_000,
  });
}

/**
 * Shared scene-commit invalidation: the campaign-wide scene prefix (same
 * literal-prefix style `useCommitUpgrade` uses, so every actor/generation
 * scoped scene read under this campaign reloads) plus the display-scoped
 * projection entries for exactly this scene. Projection keys are
 * display-first, so the scene slice is matched with a predicate — no new
 * purge prefix is introduced.
 */
function invalidateSceneReads(
  queryClient: ReturnType<typeof useQueryClient>,
  campaignId: string,
  sceneId: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["campaigns", "scene", campaignId] });
  void queryClient.invalidateQueries({
    queryKey: ["displays", "projection"],
    predicate: (query) => query.queryKey.includes(sceneId),
  });
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (displayId: string) => api.revokeDisplay(campaignId, displayId),
    onSuccess: (_data, displayId) => {
      // Purge this credential's cached projections; the display blanks on
      // its next poll. Scoped to the display — no campaign-wide purge.
      void queryClient.invalidateQueries({ queryKey: ["displays", "projection", displayId] });
    },
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
