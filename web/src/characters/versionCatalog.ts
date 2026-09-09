import { useInfiniteQuery } from "@tanstack/react-query";

import type { CharactersApi, VersionCatalogQuery } from "./api.js";
import type { CreationVersionEntry, CreationVersions } from "./types.js";

export type VersionCatalogFilters = {
  q?: string | undefined;
  systemId?: string | undefined;
};

/** Page size for the creation-version picker, mirroring the systems library. */
export const VERSION_CATALOG_PAGE_LIMIT = 20;

export function versionCatalogKey(
  actorId: string | null,
  generation: number,
  filters: VersionCatalogFilters = {},
): Array<string | number | null> {
  const key: Array<string | number | null> = ["characters", "creation-versions", actorId, generation];
  if (filters.q !== undefined || filters.systemId !== undefined) {
    key.push(filters.q ?? null, filters.systemId ?? null);
  }
  return key;
}

export type VersionCatalogPage = CreationVersions;

export function flattenCatalogPages(
  data: { pages: VersionCatalogPage[] } | undefined,
): CreationVersionEntry[] {
  // A 2xx that did not produce the expected payload must not crash the
  // picker: treat malformed pages as empty so the empty-state and manual
  // version-ID fallback stay usable.
  return (data?.pages ?? []).flatMap((page) => page.data?.versions ?? []);
}

export type UseVersionCatalogOptions = {
  /** Same guard as the previous single-shot picker: only when choosing. */
  enabled: boolean;
  online: boolean;
  filters?: VersionCatalogFilters | undefined;
};

/**
 * Infinite-scroll catalog of discoverable creation versions. The query key
 * stays account-lifetime scoped (actor + generation) with the active filters
 * appended, so each lifetime and filter set gets its own cache entry.
 * `enabled`/`staleTime` guards match the previous picker behavior.
 */
export function useVersionCatalog(
  api: CharactersApi,
  actorId: string | null,
  generation: number,
  options: UseVersionCatalogOptions,
) {
  const filters = options.filters ?? {};
  return useInfiniteQuery({
    queryKey: versionCatalogKey(actorId, generation, filters),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const query: VersionCatalogQuery = {
        cursor: pageParam,
        limit: VERSION_CATALOG_PAGE_LIMIT,
      };
      if (filters.q !== undefined) query.q = filters.q;
      if (filters.systemId !== undefined) query.systemId = filters.systemId;
      return api.listCreationVersions(query);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.data?.nextCursor ?? null,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}
