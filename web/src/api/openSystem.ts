import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemWorkspace } from "./server.js";

export type OpenSystemScope = {
  actorId: string | null;
  generation: number;
};

/**
 * Account-lifetime query key: the shared QueryClient outlives sign-out and
 * account switches, so the open-system entry is scoped by actor/generation.
 * Account B never reads account A's cached workspace without a refetch, and
 * a late A response lands under A's key where it cannot overwrite B.
 */
export function openSystemKey(
  systemId: string,
  scope?: OpenSystemScope,
): ReadonlyArray<string | number> {
  return ["system", "open", systemId, scope?.actorId ?? "signed-out", scope?.generation ?? 0];
}

export function useOpenSystem(
  client: ApiClient,
  systemId: string,
  scope?: OpenSystemScope,
): UseQueryResult<SystemWorkspace> {
  return useQuery({
    queryKey: openSystemKey(systemId, scope),
    queryFn: async () =>
      client
        .fetch<{ workspace: SystemWorkspace; requestId: string }>(
          "GET",
          `/systems/${systemId}`,
        )
        .then((r) => r.workspace),
    staleTime: 30_000,
  });
}
