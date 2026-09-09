import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { createTestLocks, makeView } from "./characters/testing.js";
import type { CharacterView, CommandResultResponse } from "./characters/types.js";
import { openCharacterStore } from "./characters/store.js";
import { createAppRouter, creationViewKey, useCharacterCoordination } from "./router.js";

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

describe("router", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders the system library + clone-from-template on /", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: "router-user" }));
      }
      return new Response(
        JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }),
        { status: 200 },
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/");
      await waitFor(() => expect(screen.getByTestId("library-route")).toBeInTheDocument());
      expect(screen.getByTestId("clone-from-template")).toBeInTheDocument();
      expect(screen.getByTestId("system-library")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("matches static /characters/new before dynamic /characters/$characterId", async () => {
    const actor = "00000000-0000-4000-8000-0000000000a1";
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: actor }));
      }
      if (url.pathname === "/api/characters/creation-versions") {
        return new Response(JSON.stringify({ data: { versions: [] }, requestId: "r" }), { status: 200 });
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/characters/new");
      expect(await screen.findByLabelText("System version ID")).toBeVisible();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("renders the system editor on /systems/$systemId", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: "router-user" }));
      }
      return new Promise<Response>(() => {});
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/systems/sys-1");
      expect(await screen.findByTestId("document-editor-loading")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("shows a sign-in prompt instead of the system editor when anonymous", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "anonymous" }));
      }
      return new Promise<Response>(() => {});
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/systems/sys-1");
      // The anonymous prompt arrives through several async gate publishes,
      // and AppShell re-renders can REPLACE the <p> node between
      // findByText's resolve and toBeInTheDocument (proven: found node
      // detached while an equivalent node is attached). Re-query inside
      // waitFor so find and attach-check happen in the same poll; the
      // generous timeout covers slow gate convergence (IndexedDB + /me)
      // under CI parallel load (proven CI failure at the default timeout).
      await waitFor(
        () => expect(screen.getByText(/sign in to open this character/i)).toBeInTheDocument(),
        { timeout: 10000 },
      );
      expect(screen.queryByTestId("document-editor-loading")).not.toBeInTheDocument();
      expect(fetch_.mock.calls.some(([input]) => String(input).includes("/systems/sys-1"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("hands the session a live coordination handle across StrictMode remount", async () => {
    // Regression: disposing a memoized handle in effect cleanup poisons the
    // reused instance, so the session's Web Lock acquisition fails forever
    // and fresh characters render "unavailable" in dev. Each setup must own
    // a fresh, undisposed handle.
    const grantingLocks = {
      request: (async (_name: string, _options: unknown, callback: (lock: object | null) => unknown) =>
        callback({})) as LockManager["request"],
    } as unknown as LockManager;
    const { result, unmount } = renderHook(
      () => useCharacterCoordination("actor-1", "char-1", { locks: grantingLocks, channel: null }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    await expect(result.current?.requestEditing()).resolves.toBe(true);
    expect(result.current?.isOwner()).toBe(true);
    const live = result.current;
    unmount();
    // Route teardown still releases and disposes the handle: no lock leaks.
    await expect(live?.requestEditing()).resolves.toBe(false);
  });

  it("keys the creation view by account lifetime as well as version input", () => {
    expect(creationViewKey("actor-1", 3, "v-1")).toBe(creationViewKey("actor-1", 3, "v-1"));
    expect(creationViewKey("actor-1", 3, "v-1")).not.toBe(creationViewKey("actor-2", 3, "v-1"));
    expect(creationViewKey("actor-1", 3, "v-1")).not.toBe(creationViewKey("actor-1", 4, "v-1"));
    expect(creationViewKey("actor-1", 3, "v-1")).not.toBe(creationViewKey("actor-1", 3, "v-2"));
    expect(creationViewKey(null, 3, "v-1")).not.toBe(creationViewKey("actor-1", 3, "v-1"));
  });
});

// Task 7: the routed character workflows through the real RouterProvider
// composition, including creation-to-focus and the full detail surface.
const ROUTER_ACTOR = "00000000-0000-4000-8000-0000000000a1";
const ROUTER_CHAR = "00000000-0000-4000-8000-0000000000e5";
const ROUTER_NEW_CHAR = "00000000-0000-4000-8000-0000000000d4";

function stubWebLocks() {
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    writable: true,
    value: createTestLocks(),
  });
}

function routerActionView(characterId: string, revision: number, name = "Briar"): CharacterView {
  return makeView({
    characterId,
    revision,
    name,
    state: { schemaVersion: "1.0", values: { name } },
    projection: {
      projectionVersion: "1.0",
      systemId: "22222222-2222-4000-8000-000000000000",
      versionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      entityId: "hero",
      entityLabel: "Hero",
      sheets: [
        {
          id: "play", label: "Play", sections: [{
            id: "moves", label: "Moves", elements: [
              {
                kind: "action" as const, id: "roll", actionId: "roll-check", label: "Roll check",
                actionKind: "roll" as const,
                inputs: [{ id: "bonus", label: "Bonus", valueType: "integer" as const, required: false, default: 0 }],
                validations: [],
              },
            ],
          }],
        },
      ],
      derivedValues: {},
      validations: [],
      completionFields: [],
    },
  });
}

function routerCompletionView(characterId: string, name: string): CharacterView {
  return makeView({
    characterId,
    revision: 1,
    name,
    state: { schemaVersion: "1.0", values: { name } },
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

describe("character routes", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    Reflect.deleteProperty(window.navigator, "locks");
    vi.restoreAllMocks();
  });

  it("prefills creation from ?systemVersionId and remounts when it changes", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ROUTER_ACTOR }));
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
      if (url.pathname === "/api/characters/creation-versions") {
        return new Response(JSON.stringify({ data: { versions: [] }, requestId: "r" }), { status: 200 });
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      const router = renderAt("/characters/new?systemVersionId=v-1");
      expect(await screen.findByLabelText("System version ID")).toHaveValue("v-1");
      await router.navigate({ to: "/characters/new", search: { systemVersionId: "v-2" } });
      await waitFor(() => expect(screen.getByLabelText("System version ID")).toHaveValue("v-2"));
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("creates through the router, navigates to the new character, and focuses required-field completion", { timeout: 30000 }, async () => {
    const user = userEvent.setup();
    stubWebLocks();
    const createdView = routerCompletionView(ROUTER_NEW_CHAR, "Briar");
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ROUTER_ACTOR }));
      }
      if (url.pathname === "/api/characters/creation-options") {
        return new Response(
          JSON.stringify({
            data: { versionId: "v-1", packageChecksum: "abc", entities: [{ id: "hero", label: "Hero" }] },
            requestId: "r",
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/characters/creation-versions") {
        return new Response(JSON.stringify({ data: { versions: [] }, requestId: "r" }), { status: 200 });
      }
      if (url.pathname === "/api/characters" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ result: { character: { characterId: ROUTER_NEW_CHAR } }, requestId: "r" }),
          { status: 200 },
        );
      }
      if (url.pathname === `/api/characters/${ROUTER_NEW_CHAR}`) {
        return new Response(JSON.stringify({ character: createdView, requestId: "r" }), { status: 200 });
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/characters/new?systemVersionId=v-1");
      expect(await screen.findByLabelText("System version ID")).toHaveValue("v-1");
      await user.click(screen.getByRole("button", { name: "Look up version" }));
      await user.selectOptions(await screen.findByLabelText("Entity"), "hero");
      await user.type(screen.getByLabelText("Character name"), "Briar");
      await user.click(screen.getByRole("button", { name: "Create character" }));
      expect(await screen.findByRole("heading", { name: "Complete Your Character" }, { timeout: 5000 })).toBeVisible();
      await waitFor(
        () => expect(screen.getByRole("heading", { name: "Complete Your Character" })).toHaveFocus(),
        { timeout: 5000 },
      );
      expect(window.location.pathname).toBe(`/characters/${ROUTER_NEW_CHAR}`);
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("exposes actions, tools, ownership and roll results through the real router composition", { timeout: 30000 }, async () => {
    const user = userEvent.setup();
    stubWebLocks();
    const seed = await openCharacterStore("sweetroll-characters");
    await seed.confirmSnapshot(ROUTER_ACTOR, ROUTER_CHAR, routerActionView(ROUTER_CHAR, 1), 0);
    await seed.close();
    const roll: NonNullable<CommandResultResponse["result"]["roll"]> = {
      actionId: "roll-check",
      expression: "d20 + 2",
      dice: [{ sides: 20, value: 14, kept: true }],
      bindings: [{ scope: "inputs", definitionId: "bonus", value: 2 }],
      total: 16,
      output: "Success",
      audience: "owner_only",
    };
    const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ROUTER_ACTOR }));
      }
      if (url.pathname.startsWith(`/api/characters/${ROUTER_CHAR}/actions/`) && init?.method === "POST") {
        return new Response(
          JSON.stringify({ result: { character: routerActionView(ROUTER_CHAR, 2), roll }, requestId: "r" }),
          { status: 200 },
        );
      }
      if (url.pathname === `/api/characters/${ROUTER_CHAR}`) {
        return new Response(JSON.stringify({ character: routerActionView(ROUTER_CHAR, 1), requestId: "r" }), { status: 200 });
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt(`/characters/${ROUTER_CHAR}`);
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" }, { timeout: 5000 })).toBeVisible();
      expect(await screen.findByText("Editing in this tab.", {}, { timeout: 5000 })).toBeVisible();
      expect(screen.getByRole("button", { name: "Activity" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Export" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Migration" })).toBeVisible();
      const rollButton = screen.getByRole("button", { name: "Roll check" });
      await waitFor(() => expect(rollButton).toBeEnabled(), { timeout: 5000 });
      await user.click(rollButton);
      expect(await screen.findByRole("heading", { name: "Roll result" }, { timeout: 5000 })).toBeVisible();
      expect(screen.getByText("d20 + 2")).toBeVisible();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });
});

// G3-3 back-navigation regression (G3 exit: deep links/back-nav survive the
// shell migration). Router-level, mocked fetch, jsdom history shim:
// library (/) -> system editor (/systems/$systemId) -> back -> library
// restores -> forward -> editor restores. Shell chrome (header + one main
// region) is asserted intact at every step: the migration must not break
// the AppShell <Outlet/> composition.
//
// Honest limits (stated, not silent): jsdom runs no layout engine and this
// exercises the router's history shim, NOT real browser chrome history
// (G9 real-device work). The editor workspace fetch never resolves, so the
// editor side asserts route restoration, not a full dirty-state round-trip:
// no edits exist at the loading state, and input-state survival across
// resizes/remounts is covered by the AppShell no-remount test instead.
describe("G3 shell migration: back navigation", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("restores library and editor routes across back/forward with shell chrome intact", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: "g3-back-nav" }));
      }
      if (url.pathname.startsWith("/api/systems/")) {
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      const router = renderAt("/");
      await waitFor(() => expect(screen.getByTestId("library-route")).toBeInTheDocument());
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getAllByRole("main")).toHaveLength(1);

      await router.navigate({ to: "/systems/$systemId", params: { systemId: "sys-1" } });
      await waitFor(() => expect(screen.getByTestId("document-editor-loading")).toBeInTheDocument());
      expect(screen.queryByTestId("library-route")).not.toBeInTheDocument();
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getAllByRole("main")).toHaveLength(1);

      router.history.back();
      await waitFor(() => expect(screen.getByTestId("library-route")).toBeInTheDocument());
      expect(screen.queryByTestId("document-editor-loading")).not.toBeInTheDocument();
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getAllByRole("main")).toHaveLength(1);

      router.history.forward();
      await waitFor(() => expect(screen.getByTestId("document-editor-loading")).toBeInTheDocument());
      expect(screen.queryByTestId("library-route")).not.toBeInTheDocument();
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getAllByRole("main")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });
});
