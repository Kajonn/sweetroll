import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import type { CoordinationPort, IdentityPort } from "./session.js";
import { createTestLocks, makeEnvelope, makeEntry, makeOpenEnvelope, makeView } from "./testing.js";
import type {
  CharacterExport,
  CharacterView,
  CommandResultResponse,
  FrozenRequest,
  MigrationPreviewResponse,
} from "./types.js";
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

  it("opens a character through identity, store, session and renderer, then releases the session", async () => {
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
      // The session releases the lock on teardown, but the coordination
      // handle is route-owned: disposing it here would poison StrictMode
      // remounts that reuse the handle.
      expect(letGo).toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
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

  it("C3 never opens a session or sends with a null actor", async () => {
    const store = await openStore();
    const api = makeApi();
    const letGo = vi.fn();
    const dispose = vi.fn();
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity({ getActorId: () => null })}
          coordination={makeCoordination(false, { letGo, dispose })}
        />,
      );
      expect(await screen.findByText("Sign in to open this character.")).toBeVisible();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(api.open).not.toHaveBeenCalled();
      expect(letGo).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});

// Task 7: the complete I4 surface reachable through the routed composition.
// These tests drive the real session/store/panels through CharacterDetail
// instead of rendering tools or review surfaces alone.
type WorkflowApi = CharactersApi & {
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  activity: ReturnType<typeof vi.fn>;
  export: ReturnType<typeof vi.fn>;
  previewMigration: ReturnType<typeof vi.fn>;
};

function actionView(revision: number, name = "Briar"): CharacterView {
  return makeView({
    characterId: CHARACTER_ID,
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

const ROLL_RESULT: NonNullable<CommandResultResponse["result"]["roll"]> = {
  actionId: "roll-check",
  expression: "d20 + 2",
  dice: [{ sides: 20, value: 14, kept: true }],
  bindings: [{ scope: "inputs", definitionId: "bonus", value: 2 }],
  total: 16,
  output: "Success",
  audience: "owner_only",
};

function makeWorkflowApi(handlers: {
  openView: () => CharacterView;
  onSend?: (request: FrozenRequest) => CommandResultResponse;
}): WorkflowApi {
  const send = vi.fn(async (request: FrozenRequest) => {
    if (handlers.onSend !== undefined) return handlers.onSend(request);
    return makeEnvelope(handlers.openView());
  });
  return {
    open: vi.fn(async () => makeOpenEnvelope(handlers.openView())),
    creationOptions: vi.fn(),
    activity: vi.fn(async () => ({ events: [], nextCursor: null, requestId: "r" })),
    send,
    export: vi.fn(async () => {
      throw new Error("unused");
    }),
    previewMigration: vi.fn(async () => {
      throw new Error("unused");
    }),
  } as unknown as WorkflowApi;
}

function stubWebLocks() {
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    writable: true,
    value: createTestLocks(),
  });
}

function restoreWebLocks() {
  Reflect.deleteProperty(window.navigator, "locks");
}

describe("CharacterRoute workflows", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
    restoreWebLocks();
    vi.restoreAllMocks();
  });

  it("invokes an authored action through the routed session and shows the authoritative roll result", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const api = makeWorkflowApi({
      openView: () => actionView(1),
      onSend: request => {
        expect(request.path).toBe(`/characters/${CHARACTER_ID}/actions/roll-check`);
        return { result: { character: actionView(2), roll: ROLL_RESULT }, requestId: "req-roll" };
      },
    });
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true)} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      // The sheet renders before the session settles; drive controls only
      // once the session is ready, otherwise clicks hit disabled buttons.
      const rollButton = await screen.findByRole("button", { name: "Roll check" });
      await waitFor(() => expect(rollButton).toBeEnabled(), { timeout: 5000 });
      await user.click(rollButton);
      expect(await screen.findByRole("heading", { name: "Roll result" })).toBeVisible();
      expect(screen.getByText("d20 + 2")).toBeVisible();
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    } finally {
      await store.close();
    }
  });

  it("opens activity and export tools from the routed sheet", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const serverDocument = {
      schemaVersion: "1.0",
      mediaType: "application/vnd.sweetroll.character+json;version=1",
      characterId: CHARACTER_ID,
      name: "Briar",
      entityDefinitionId: "hero",
      lifecycle: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      systemVersionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      revision: 1,
      state: { schemaVersion: "1.0", values: { name: "Briar" } },
      migrationLineage: [],
    } as unknown as CharacterExport;
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    api.activity.mockResolvedValue({
      events: [
        { id: "a1", characterRevision: 1, kind: "field-set", payload: {}, rollId: null, requestId: "r", occurredAt: "2026-09-06T00:00:00.000Z" },
      ],
      nextCursor: null,
      requestId: "r",
    });
    api.export.mockResolvedValue(serverDocument);
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    (URL as unknown as Record<string, unknown>).createObjectURL = (() => "blob:export") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn(() => {}) as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {});
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true)} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      // Export gates on a settled session, so its enabled state proves the
      // session is ready before driving any tool below.
      const exportButton = await screen.findByRole("button", { name: "Export" });
      await waitFor(() => expect(exportButton).toBeEnabled(), { timeout: 5000 });
      const activityButton = await screen.findByRole("button", { name: "Activity" });
      await user.click(activityButton);
      expect(await screen.findByText("field-set")).toBeVisible();
      expect(api.activity).toHaveBeenCalledWith(CHARACTER_ID, null);
      await user.click(screen.getByRole("button", { name: "Close" }));
      await user.click(exportButton);
      await user.click(screen.getByRole("button", { name: "Download export" }));
      await waitFor(() => expect(api.export).toHaveBeenCalledWith(CHARACTER_ID));
      expect(clickSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      clickSpy.mockRestore();
      await store.close();
    }
  });

  it("archives and recovers through the routed tools without a second mutation path", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    // Stateful server double: the session refuses to manage against a stale
    // GET, so the mock must track lifecycle/revision like the real backend.
    let current = actionView(1);
    const api = makeWorkflowApi({
      openView: () => current,
      onSend: request => {
        const command = (request.body as { command?: string }).command;
        const revision = current.reconciliation.revision + 1;
        current = command === "archive" ? { ...actionView(revision), lifecycle: "archived" } : actionView(revision);
        return makeEnvelope(current);
      },
    });
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true)} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      const archiveButton = await screen.findByRole("button", { name: "Archive" });
      await waitFor(() => expect(archiveButton).toBeEnabled(), { timeout: 5000 });
      await user.click(archiveButton);
      await user.click(screen.getByRole("button", { name: "Confirm archive" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      expect(api.send.mock.calls[0]?.[0].body).toMatchObject({ command: "archive" });
      // Wait for the post-ack settle: the recover confirm guard reads the
      // settled snapshot, and a stale GET must never block it.
      await waitFor(() => expect(screen.getByText("Saved")).toBeVisible(), { timeout: 5000 });
      const recover = await screen.findByRole("button", { name: "Recover" });
      await waitFor(() => expect(recover).toBeEnabled());
      await user.click(recover);
      await user.click(screen.getByRole("button", { name: "Confirm recover" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
      expect(api.send.mock.calls[1]?.[0].body).toMatchObject({ command: "recover" });
    } finally {
      await store.close();
    }
  });

  it("previews, commits and rolls back a migration through the routed tools", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const preview = {
      preview: {
        previewId: "p-1",
        characterId: CHARACTER_ID,
        sourceRevision: 1,
        sourceVersionId: "11111111-1111-4000-8000-000000000000",
        targetVersionId: "v-2",
        candidateState: { schemaVersion: "1.0", values: { name: "Briar" } },
        candidateProjection: {},
        warnings: ["Type change on health"],
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      requestId: "r",
    } as unknown as MigrationPreviewResponse;
    // Stateful server double (see the archive test): later management calls
    // reconcile against a fresh GET, which must not look older than confirmed.
    let current = actionView(1);
    const api = makeWorkflowApi({
      openView: () => current,
      onSend: () => {
        current = actionView(current.reconciliation.revision + 1);
        return makeEnvelope(current);
      },
    });
    api.previewMigration.mockResolvedValue(preview);
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true)} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      const migrationButton = await screen.findByRole("button", { name: "Migration" });
      await waitFor(() => expect(screen.getByText("Saved")).toBeVisible(), { timeout: 5000 });
      await user.click(migrationButton);
      await user.type(screen.getByLabelText("Target version"), "v-2");
      const previewButton = screen.getByRole("button", { name: "Preview migration" });
      await waitFor(() => expect(previewButton).toBeEnabled(), { timeout: 5000 });
      await user.click(previewButton);
      expect(await screen.findByText("Type change on health")).toBeVisible();
      await user.click(screen.getByLabelText(/reviewed this preview/i));
      await user.click(screen.getByRole("button", { name: "Commit migration" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      expect(api.send.mock.calls[0]?.[0].path).toBe(`/characters/${CHARACTER_ID}/migrations/p-1/commit`);
      await waitFor(() => expect(screen.getByText("Saved")).toBeVisible(), { timeout: 5000 });
      await user.click(screen.getByRole("button", { name: "Migration" }));
      expect(await screen.findByText(/p-1/)).toBeVisible();
      await user.click(screen.getByRole("button", { name: /use last migration/i }));
      expect(screen.getByLabelText("Migration ID")).toHaveValue("p-1");
      await user.click(screen.getByRole("button", { name: "Roll back migration" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
      expect(api.send.mock.calls[1]?.[0].path).toBe(`/characters/${CHARACTER_ID}/migrations/p-1/rollback`);
    } finally {
      await store.close();
    }
  });

  it("resolves a simulated conflict from the routed review surface", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    await store.enqueue(
      makeEntry({
        id: "e1",
        actorId: ACTOR,
        characterId: CHARACTER_ID,
        sequence: 1,
        baseRevision: 1,
        packageChecksum: "abc",
        createdAt: "2026-09-06T00:00:00.000Z",
        intent: { kind: "setField", fieldId: "name", value: "Briar" },
        attempt: null,
      }),
      await store.read(ACTOR, CHARACTER_ID),
    );
    const api = makeWorkflowApi({
      openView: () => actionView(7, "Server"),
      onSend: request => {
        expect((request.body as { value?: unknown }).value).toBe("Briar");
        return makeEnvelope(actionView(8, "Briar"));
      },
    });
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true)} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { name: "Review conflicts" })).toBeVisible();
      await user.click(screen.getByRole("checkbox", { name: /Briar/ }));
      await user.click(screen.getByRole("button", { name: "Reapply" }));
      await user.click(screen.getByRole("button", { name: "Confirm reapply" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      const key = (api.send.mock.calls[0]?.[0].body as { idempotencyKey?: unknown }).idempotencyKey;
      expect(typeof key).toBe("string");
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "Review conflicts" })).not.toBeInTheDocument(),
      );
      await waitFor(() => {
        const saved = screen.getAllByRole("status").some(element => element.textContent === "Saved");
        expect(saved).toBe(true);
      });
    } finally {
      await store.close();
    }
  });

  it("lets a read-only second tab request takeover without closing the first page", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    const ownerLetGo = vi.fn();
    try {
      const owner = render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(true, { letGo: ownerLetGo })} locksSupported
        />,
      );
      const ownerQueries = within(owner.container);
      expect(await ownerQueries.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      let readerOwned = false;
      const requestTakeover = vi.fn(async () => {
        readerOwned = true;
        return true;
      });
      const readerCoordination: CoordinationPort = {
        isOwner: () => readerOwned,
        requestEditing: async () => readerOwned,
        requestTakeover,
        letGo: () => {},
        subscribe: () => () => {},
        setQuiesce: () => {},
        invalidate: () => {},
        dispose: () => {},
      };
      const reader = render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={readerCoordination} locksSupported
        />,
      );
      // NOTE: render-result queries bind to document.body, so scope to each
      // tab's container explicitly: both tabs are mounted at once.
      const readerQueries = within(reader.container);
      expect(await readerQueries.findByText("Read-only in this tab. Another tab is editing this character.")).toBeVisible();
      // Wait for startup to settle: only an initialized session routes the
      // request through takeover instead of a polite first acquisition.
      await readerQueries.findByText("Saved", {}, { timeout: 5000 });
      const requestButton = readerQueries.getByRole("button", { name: "Request editing access" });
      await waitFor(() => expect(requestButton).toBeEnabled(), { timeout: 5000 });
      await user.click(requestButton);
      expect(requestTakeover).toHaveBeenCalledTimes(1);
      expect(await readerQueries.findByText("Editing in this tab.")).toBeVisible();
      // Takeover never stood in for closing the first page.
      expect(ownerLetGo).not.toHaveBeenCalled();
      expect(ownerQueries.getByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      owner.unmount();
      reader.unmount();
    } finally {
      await store.close();
    }
  });

  it("stays read-only with a reason when Web Locks are unsupported", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={makeCoordination(false)}
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      expect(await screen.findByText(/does not support Web Locks/)).toBeVisible();
      expect(screen.queryByRole("button", { name: /request editing/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Roll check" })).toBeDisabled();
    } finally {
      await store.close();
    }
  });

  it("hides the old account cache on switch without flashing private data", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    let switched = false;
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    api.open.mockImplementation(async () => {
      if (!switched) return makeOpenEnvelope(actionView(1));
      throw new ApiError({
        code: "not_found", message: "No access.", status: 404,
        requestId: "req-1", latestRevision: null, diagnostics: [], cacheDisposition: "purge",
      });
    });
    const letGo = vi.fn();
    const coordination = makeCoordination(true, { letGo });
    try {
      const view = render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity()} coordination={coordination} locksSupported
        />,
      );
      expect(await view.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      switched = true;
      view.rerender(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity({ getActorId: () => OTHER_ACTOR, getGeneration: () => 1 })}
          coordination={coordination} locksSupported
        />,
      );
      // The old account's screen never flashes for the new actor.
      expect(view.queryByRole("heading", { name: "Briar" })).not.toBeInTheDocument();
      expect(view.queryByText("Briar")).not.toBeInTheDocument();
      expect(await view.findByText("This character is unavailable.")).toBeVisible();
      expect(letGo).toHaveBeenCalled();
      expect((await store.read(ACTOR, CHARACTER_ID)).confirmed?.name).toBe("Briar");
    } finally {
      await store.close();
    }
  });

  it("keeps a single live session under StrictMode without disposing the shared coordination", async () => {
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    const letGo = vi.fn();
    const dispose = vi.fn();
    try {
      render(
        <StrictMode>
          <CharacterDetail
            characterId={CHARACTER_ID} api={api} store={store}
            identity={makeIdentity()} coordination={makeCoordination(true, { letGo, dispose })} locksSupported
          />
        </StrictMode>,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      // The StrictMode remount disposes exactly one superseded session; the
      // route-owned coordination handle itself is never disposed.
      await waitFor(() => expect(letGo).toHaveBeenCalledTimes(1));
      expect(dispose).not.toHaveBeenCalled();
      expect(screen.getAllByRole("heading", { level: 1, name: "Briar" })).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("navigates within the SPA through callbacks instead of full page loads", async () => {
    const user = userEvent.setup();
    const store = await openStore();
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, actionView(1), 0);
    const api = makeWorkflowApi({ openView: () => actionView(1) });
    const navigation = { onCreateNew: vi.fn(), onOpenLibrary: vi.fn(), onOpenCharacter: vi.fn() };
    try {
      render(
        <CharacterDetail
          characterId={CHARACTER_ID} api={api} store={store}
          identity={makeIdentity({ isOnline: () => false })} coordination={makeCoordination(false)}
          navigation={navigation} locksSupported
        />,
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Briar" })).toBeVisible();
      const createLink = screen.getByRole("link", { name: "Create a new character" });
      expect(createLink).toHaveAttribute("href", "/characters/new");
      await user.click(createLink);
      expect(navigation.onCreateNew).toHaveBeenCalledTimes(1);
      const libraryLink = screen.getByRole("link", { name: "Back to library" });
      expect(libraryLink).toHaveAttribute("href", "/");
      await user.click(libraryLink);
      expect(navigation.onOpenLibrary).toHaveBeenCalledTimes(1);
      expect(navigation.onOpenCharacter).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
