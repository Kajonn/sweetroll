import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import type { CoordinationPort, IdentityPort } from "./session.js";
import { makeOpenEnvelope, makeView } from "./testing.js";
import { CharacterDetail } from "./CharacterRoute.js";
import { createAppRouter } from "../router.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ACTOR = "00000000-0000-4000-8000-0000000000b2";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000c3";

function completionView() {
  return makeView({
    characterId: CHARACTER_ID,
    revision: 1,
    name: "Briar",
    projection: {
      projectionVersion: "1.0",
      systemId: "22222222-2222-4000-8000-000000000000",
      versionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      entityId: "hero",
      entityLabel: "Hero",
      sheets: [],
      derivedValues: {},
      validations: [],
      completionFields: [
        {
          kind: "field" as const, id: "completion-name", fieldId: "name", label: "Name",
          fieldKind: "text" as const, value: "", editable: true,
          constraints: { required: true }, validations: [],
        },
      ],
    },
  });
}

async function openStore(): Promise<CharacterStore> {
  return openCharacterStore(`route-test-${crypto.randomUUID()}`);
}

function makeIdentity(overrides: Partial<IdentityPort> = {}): IdentityPort {
  return {
    getActorId: () => ACTOR,
    getGeneration: () => 0,
    isOnline: () => true,
    isCurrent: async () => true,
    subscribe: () => () => {},
    ...overrides,
  };
}

function makeCoordination(owned: boolean, spies: { letGo?: () => void; dispose?: () => void } = {}): CoordinationPort {
  return {
    isOwner: () => owned,
    requestEditing: async () => owned,
    letGo: () => { spies.letGo?.(); },
    subscribe: () => () => {},
    setQuiesce: () => {},
    invalidate: () => {},
    dispose: () => { spies.dispose?.(); },
    requestTakeover: async () => owned,
  };
}

function makeApi(view = completionView()): CharactersApi & { open: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => makeOpenEnvelope(view)),
    creationOptions: vi.fn(),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
    previewMigration: vi.fn(),
  } as unknown as CharactersApi & { open: ReturnType<typeof vi.fn> };
}

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const router = createAppRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("CharacterRoute", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("opens a character through identity, store, session and renderer, then disposes the session", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, completionView(), 0);
    const letGo = vi.fn();
    const dispose = vi.fn();
    const api = makeApi();
    try {
      const { unmount } = render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true, { letGo, dispose })}
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      unmount();
      expect(letGo).toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("focuses required-field guidance after navigation", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, completionView(), 0);
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={makeApi()} store={store}
          identity={makeIdentity()} coordination={makeCoordination(false)}
        />,
      );
      expect(await screen.findByRole("heading", { name: "Complete Your Character" })).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Complete Your Character" })).toHaveFocus(),
      );
    } finally {
      await store.close();
    }
  });

  it("shows cached-character recovery links offline without library search", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, completionView(), 0);
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={makeApi()} store={store}
          identity={makeIdentity({ isOnline: () => false })}
          coordination={makeCoordination(false)}
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      const createLink = screen.getByRole("link", { name: "Create a new character" });
      expect(createLink).toHaveAttribute("href", "/characters/new");
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("does not expose another account's cache on a deep link", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, completionView(), 0);
    const api = makeApi();
    api.open.mockRejectedValueOnce(
      new ApiError({
        code: "not_found", message: "No access.", status: 404,
        requestId: "req-1", latestRevision: null, diagnostics: [], cacheDisposition: "purge",
      }),
    );
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity({ getActorId: () => OTHER_ACTOR })}
          coordination={makeCoordination(true)}
        />,
      );
      await waitFor(() => expect(api.open).toHaveBeenCalled());
      expect(screen.queryByRole("heading", { level: 1, name: "Briar" })).not.toBeInTheDocument();
      expect(screen.queryByText("Briar")).not.toBeInTheDocument();
      const reread = await store.read(ACTOR, CHARACTER_ID);
      expect(reread.confirmed?.name).toBe("Briar");
    } finally {
      await store.close();
    }
  });

  it("keeps the creation route online-only and preserves existing System Builder routes", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ACTOR }));
      }
      if (url.pathname === "/api/systems" || url.pathname.startsWith("/api/systems/")) {
        return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Missing" }, requestId: "r" }), { status: 404 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/");
      await waitFor(() => expect(screen.getByTestId("library-route")).toBeInTheDocument());
      expect(screen.getByTestId("system-library")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("renders the creation route with the version search input", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ACTOR }));
      }
      if (url.pathname === "/api/characters/creation-options") {
        return new Response(
          JSON.stringify({
            data: { versionId: url.searchParams.get("systemVersionId"), packageChecksum: "abc", entities: [] },
            requestId: "r",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/characters/new");
      expect(await screen.findByLabelText("System version ID")).toBeVisible();
      await user.type(screen.getByLabelText("System version ID"), "v-1");
      await user.click(screen.getByRole("button", { name: "Look up version" }));
      await waitFor(() =>
        expect(fetch_.mock.calls.some(([input]) => String(input).includes("/api/characters/creation-options"))).toBe(true),
      );
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });
});
