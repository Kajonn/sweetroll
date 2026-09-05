import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemWorkspace } from "./server.js";

export function useOpenSystem(
  client: ApiClient,
  systemId: string,
): UseQueryResult<SystemWorkspace> {
  return useQuery({
    queryKey: ["system", "open", systemId],
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
