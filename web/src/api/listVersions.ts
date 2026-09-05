import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { VersionSummary } from "./server.js";

export type ListVersionsResult = { versions: VersionSummary[]; requestId: string };

export function useListVersions(
  client: ApiClient,
  systemId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<VersionSummary[]> {
  return useQuery({
    queryKey: ["system", "versions", systemId],
    queryFn: async () =>
      client
        .fetch<ListVersionsResult>("GET", `/systems/${systemId}/versions`)
        .then((r) => r.versions),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
