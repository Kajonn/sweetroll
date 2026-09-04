import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";

export type MeState = { state: "authenticated"; userId: string } | { state: "anonymous" };

export function useMe(client: ApiClient): UseQueryResult<MeState> {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => client.fetch<MeState>("GET", "/me"),
    staleTime: 60_000,
  });
}
