import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { CreationVersionEntry, CreationVersions } from "../characters/types.js";

export function useCreationVersions(
  client: ApiClient,
  options: { enabled?: boolean } = {},
): UseQueryResult<CreationVersionEntry[]> {
  return useQuery({
    queryKey: ["characters", "creation-versions"],
    queryFn: async () =>
      client
        .fetch<CreationVersions>("GET", "/characters/creation-versions")
        .then((r) => r.data.versions),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
