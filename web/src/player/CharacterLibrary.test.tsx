import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CharactersApi } from "../characters/api.js";
import type { CharacterSummary } from "../characters/types.js";
import { CharacterLibrary } from "./CharacterLibrary.js";
import {
  CHARACTER_LIBRARY_PAGE_LIMIT,
  characterLibraryKey,
  filterLibraryCharacters,
  flattenLibraryPages,
  recentLibraryCharacters,
} from "./characterQueries.js";

function makeApi(): CharactersApi & {
  listCharacters: ReturnType<typeof vi.fn>;
  duplicateCharacter: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    creationOptions: vi.fn(),
    listCreationVersions: vi.fn(),
    listCharacters: vi.fn(),
    duplicateCharacter: vi.fn(),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
    previewMigration: vi.fn(),
  } as unknown as CharactersApi & {
    listCharacters: ReturnType<typeof vi.fn>;
    duplicateCharacter: ReturnType<typeof vi.fn>;
  };
}

function renderLibrary(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...render(node, { wrapper }), qc };
}

function makeIdentity() {
  return { getActorId: () => "actor-1", getGeneration: () => 0, isOnline: () => true };
}

function summary(id: string, name: string, lifecycle: "active" | "archived" = "active"): CharacterSummary {
  return {
    characterId: id,
    name,
    entityDefinitionId: "character",
    systemVersionId: "11111111-1111-4000-8000-000000000001",
    revision: 1,
    lifecycle,
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("characterQueries", () => {
  it("scopes the library key by account lifetime", () => {
    expect(characterLibraryKey("actor-A", 0)).toEqual(["characters", "library", "actor-A", 0]);
    expect(characterLibraryKey("actor-A", 1)).toEqual(["characters", "library", "actor-A", 1]);
  });

  it("flattens fetched pages and tolerates malformed pages", () => {
    const a = summary("id-a", "Aria");
    const b = summary("id-b", "Bram");
    expect(
      flattenLibraryPages({
        pages: [
          { characters: [a], nextCursor: "cursor-1", requestId: "r-1" },
          { characters: [b], nextCursor: null, requestId: "r-2" },
        ],
      }),
    ).toEqual([a, b]);
    expect(flattenLibraryPages(undefined)).toEqual([]);
    expect(flattenLibraryPages({ pages: [{} as never] })).toEqual([]);
  });

  it("filters case-insensitively and falls back to server order for recent", () => {
    const characters = [summary("id-a", "Aria"), summary("id-b", "Bram")];
    expect(filterLibraryCharacters(characters, "ar")).toEqual([characters[0]]);
    expect(filterLibraryCharacters(characters, "")).toEqual(characters);
    expect(recentLibraryCharacters(characters, [], 5)).toEqual(characters);
    expect(recentLibraryCharacters(characters, ["id-b", "id-a"], 1)).toEqual([characters[1]]);
  });
});

describe("CharacterLibrary", () => {
  it("lists characters with recent rail, detail links and a create link", async () => {
    const api = makeApi();
    api.listCharacters.mockResolvedValue({
      characters: [summary("id-a", "Aria"), summary("id-b", "Bram")],
      nextCursor: null,
      requestId: "r-1",
    });
    renderLibrary(<CharacterLibrary api={api} identity={makeIdentity()} />);

    expect(await screen.findByRole("heading", { name: "Characters" })).toBeVisible();
    expect(api.listCharacters).toHaveBeenCalledWith({ cursor: null, limit: CHARACTER_LIBRARY_PAGE_LIMIT });
    const create = screen.getByTestId("character-library-create");
    expect(create).toHaveAttribute("href", "/characters/new");

    const row = await screen.findByTestId("library-row-id-a");
    const open = within(row).getByRole("link", { name: "Open Aria" });
    expect(open).toHaveAttribute("href", "/characters/id-a");
    expect(within(row).getByRole("button", { name: "Duplicate Aria" })).toBeVisible();
  });

  it("searches loaded pages client-side and offers load more while pages remain", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.listCharacters.mockImplementation(async (input?: { cursor?: string | null }) => {
      if (input?.cursor === "cursor-1") {
        return { characters: [summary("id-c", "Cora")], nextCursor: null, requestId: "r-2" };
      }
      return { characters: [summary("id-a", "Aria"), summary("id-b", "Bram")], nextCursor: "cursor-1", requestId: "r-1" };
    });
    renderLibrary(<CharacterLibrary api={api} identity={makeIdentity()} />);
    await screen.findByTestId("library-row-id-a");

    await user.type(screen.getByTestId("character-library-search"), "br");
    expect(screen.queryByTestId("library-row-id-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-row-id-b")).toBeVisible();
    // The server list has no q parameter: search filters loaded pages and
    // the view says load-more extends the searched set.
    expect(screen.getByText(/covers the characters loaded so far/)).toBeVisible();

    await user.clear(screen.getByTestId("character-library-search"));
    await user.click(screen.getByTestId("character-library-load-more"));
    expect(await screen.findByTestId("library-row-id-c")).toBeVisible();
  });

  it("duplicates through the API seam with a fresh idempotency key and refreshes", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const copy = summary("id-copy", "Aria");
    // First fetch seeds one row; the post-duplicate refetch returns the copy.
    let fetches = 0;
    api.listCharacters.mockImplementation(async () => {
      fetches += 1;
      return fetches === 1
        ? { characters: [summary("id-a", "Aria")], nextCursor: null, requestId: "r-1" }
        : { characters: [copy, summary("id-a", "Aria")], nextCursor: null, requestId: "r-3" };
    });
    api.duplicateCharacter.mockResolvedValue({ character: { characterId: "id-copy" }, requestId: "r-d" });
    renderLibrary(<CharacterLibrary api={api} identity={makeIdentity()} />);
    await screen.findByTestId("library-row-id-a");

    await user.click(screen.getByTestId("library-duplicate-id-a"));
    await waitFor(() => expect(api.duplicateCharacter).toHaveBeenCalledTimes(1));
    expect(api.duplicateCharacter).toHaveBeenCalledWith("id-a", {
      idempotencyKey: expect.any(String),
    });

    await waitFor(() => expect(screen.getByTestId("library-row-id-copy")).toBeVisible());
  });

  it("shows the empty state with a create link when the library is empty", async () => {
    const api = makeApi();
    api.listCharacters.mockResolvedValue({ characters: [], nextCursor: null, requestId: "r-1" });
    renderLibrary(<CharacterLibrary api={api} identity={makeIdentity()} />);
    expect(await screen.findByText("No characters yet.")).toBeVisible();
    expect(screen.getByTestId("character-library-create")).toHaveAttribute("href", "/characters/new");
  });
});
