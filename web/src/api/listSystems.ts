import { useInfiniteQuery } from "@tanstack/react-query";

import type { ApiClient } from "./client.js";
import type { SystemSummary } from "./server.js";

export type LibraryPage = { systems: SystemSummary[]; nextCursor: string | null; requestId: string };

export function useSystemLibrary(client: ApiClient) {
  return useInfiniteQuery({
    queryKey: ["system", "library"],
    queryFn: async ({ pageParam }) => client.fetch<LibraryPage>("GET", "/systems", { query: { cursor: pageParam, limit: 20 } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}
