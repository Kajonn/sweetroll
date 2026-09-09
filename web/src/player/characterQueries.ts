import { useInfiniteQuery } from "@tanstack/react-query";

import type { CharactersApi, CharacterListQuery } from "../characters/api.js";
import type { CharacterList, CharacterSummary } from "../characters/types.js";

/** Page size for the character library, mirroring the creation-version picker. */
export const CHARACTER_LIBRARY_PAGE_LIMIT = 20;

/** How many server-ordered entries the recent rail shows. */
export const CHARACTER_LIBRARY_RECENT_COUNT = 5;

export function characterLibraryKey(
  actorId: string | null,
  generation: number,
): Array<string | number | null> {
  return ["characters", "library", actorId, generation];
}

export type CharacterLibraryPage = CharacterList;

export function flattenLibraryPages(
  data: { pages: CharacterLibraryPage[] } | undefined,
): CharacterSummary[] {
  // A 2xx that did not produce the expected payload must not crash the
  // library: treat malformed pages as empty so the empty-state and create
  // link stay usable.
  return (data?.pages ?? []).flatMap((page) => page.characters ?? []);
}

export type UseCharacterLibraryOptions = {
  /** Same guard as the creation picker: only fetch while the view is live. */
  enabled: boolean;
  online: boolean;
};

/**
 * Infinite-scroll library of the current account's characters. The query key
 * stays account-lifetime scoped (actor + generation) so each lifetime gets
 * its own cache entry. `enabled`/`staleTime` guards match the picker.
 */
export function useCharacterLibrary(
  api: CharactersApi,
  actorId: string | null,
  generation: number,
  options: UseCharacterLibraryOptions,
) {
  return useInfiniteQuery({
    queryKey: characterLibraryKey(actorId, generation),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const query: CharacterListQuery = {
        cursor: pageParam,
        limit: CHARACTER_LIBRARY_PAGE_LIMIT,
      };
      return api.listCharacters(query);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}

/**
 * Client-side search over the loaded pages. The server list endpoint has no
 * `q` parameter, so search only covers what has been fetched; callers offer
 * "load more" alongside filtered results and say so honestly.
 */
export function filterLibraryCharacters(characters: CharacterSummary[], q: string): CharacterSummary[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return characters;
  return characters.filter((character) => character.name.toLowerCase().includes(needle));
}

export function filterLibraryByLifecycle(
  characters: CharacterSummary[],
  lifecycle: "all" | "active" | "archived",
): CharacterSummary[] {
  if (lifecycle === "all") return characters;
  return characters.filter((character) => character.lifecycle === lifecycle);
}

/**
 * Recent rail: recently-opened ids (recorded client-side from this same
 * data — there is no separate endpoint) in recency order, falling back to
 * server order when nothing has been opened yet.
 */
export function recentLibraryCharacters(
  characters: CharacterSummary[],
  openedIds: readonly string[],
  count: number = CHARACTER_LIBRARY_RECENT_COUNT,
): CharacterSummary[] {
  const byId = new Map(characters.map((character) => [character.characterId, character]));
  const opened = openedIds.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
  if (opened.length > 0) return opened.slice(0, count);
  return characters.slice(0, count);
}
