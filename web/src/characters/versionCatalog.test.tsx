import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import { CreateCharacter } from "./CreateCharacter.js";
import {
  flattenCatalogPages,
  VERSION_CATALOG_PAGE_LIMIT,
  versionCatalogKey,
} from "./versionCatalog.js";

function makeApi(): CharactersApi & { listCreationVersions: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(),
    creationOptions: vi.fn(),
    listCreationVersions: vi.fn(),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
    previewMigration: vi.fn(),
  } as unknown as CharactersApi & { listCreationVersions: ReturnType<typeof vi.fn> };
}

function renderCatalog(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...render(node, { wrapper }), qc };
}

function makeIdentity() {
  return { getActorId: () => "actor-1", isOnline: () => true };
}

async function openStore(): Promise<CharacterStore> {
  return openCharacterStore(`catalog-test-${crypto.randomUUID()}`);
}

function version(id: string, systemName: string) {
  return {
    versionId: id,
    systemId: `system-${systemName}`,
    systemName,
    semanticVersion: "1.0.0",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("versionCatalog", () => {
  it("scopes the infinite-query key by account lifetime and filters", () => {
    expect(versionCatalogKey("actor-A", 0)).toEqual([
      "characters",
      "creation-versions",
      "actor-A",
      0,
    ]);
    expect(versionCatalogKey("actor-A", 1, { q: "alp", systemId: "system-1" })).toEqual([
      "characters",
      "creation-versions",
      "actor-A",
      1,
      "alp",
      "system-1",
    ]);
    expect(versionCatalogKey("actor-A", 1, { systemId: "system-1" })).toEqual([
      "characters",
      "creation-versions",
      "actor-A",
      1,
      null,
      "system-1",
    ]);
  });

  it("flattens fetched pages into one version list", () => {
    const a = version("aaaaaaaa-aaaa-4000-8000-000000000001", "Alpha");
    const b = version("bbbbbbbb-bbbb-4000-8000-000000000002", "Beta");
    expect(
      flattenCatalogPages({
        pages: [
          { data: { versions: [a], nextCursor: "cursor-1" }, requestId: "r-1" },
          { data: { versions: [b], nextCursor: null }, requestId: "r-2" },
        ],
      }),
    ).toEqual([a, b]);
    expect(flattenCatalogPages(undefined)).toEqual([]);
  });

  it("picker loads the first page with the catalog limit and offers more while nextCursor is set", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const first = version("aaaaaaaa-aaaa-4000-8000-000000000001", "Alpha");
    const second = version("bbbbbbbb-bbbb-4000-8000-000000000002", "Beta");
    api.listCreationVersions.mockImplementation(async (input?: { cursor?: string | null }) => {
      if (input?.cursor === "cursor-1") {
        return { data: { versions: [second], nextCursor: null }, requestId: "r-2" };
      }
      return { data: { versions: [first], nextCursor: "cursor-1" }, requestId: "r-1" };
    });
    const store = await openStore();
    try {
      renderCatalog(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("button", { name: "Alpha 1.0.0" })).toBeVisible();
      expect(api.listCreationVersions).toHaveBeenCalledWith({
        cursor: null,
        limit: VERSION_CATALOG_PAGE_LIMIT,
      });
      expect(screen.queryByRole("button", { name: "Beta 1.0.0" })).not.toBeInTheDocument();

      await user.click(await screen.findByRole("button", { name: "Load more versions" }));
      expect(await screen.findByRole("button", { name: "Beta 1.0.0" })).toBeVisible();
      expect(api.listCreationVersions).toHaveBeenLastCalledWith({
        cursor: "cursor-1",
        limit: VERSION_CATALOG_PAGE_LIMIT,
      });
      // Both pages stay visible and the pager retires once exhausted.
      expect(screen.getByRole("button", { name: "Alpha 1.0.0" })).toBeVisible();
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Load more versions" })).not.toBeInTheDocument(),
      );
    } finally {
      await store.close();
    }
  });

  it("picker without a next cursor shows a single page and no pager", async () => {
    const api = makeApi();
    api.listCreationVersions.mockResolvedValue({
      data: { versions: [version("aaaaaaaa-aaaa-4000-8000-000000000001", "Alpha")], nextCursor: null },
      requestId: "r-1",
    });
    const store = await openStore();
    try {
      renderCatalog(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("button", { name: "Alpha 1.0.0" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Load more versions" })).not.toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
